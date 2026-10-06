extends Node
const Lang := preload("res://scripts/core/lang.gd")

const CFG_PATH := "user://settings.cfg"
## Мост SDK Яндекс Игр: в Android-сборку файл не входит (исключён из
## пресета), поэтому везде проверяется ResourceLoader.exists.
const YANDEX_SDK_SCRIPT := "res://scripts/platform/yandex_sdk.gd"
const MIN_PLAYERS := 2
const MAX_PLAYERS := 5

## Лестница масштабов: маленький — ровно прежний ×1.0 (вёрстка под
## него родная), большой — ×2, чтобы весь текст был заметно крупным.
## «Маленького» ×0.85 больше нет. Потолоков у текста нет, зато есть
## пол FS_MIN: мелкие базы не опускаются ниже читаемого минимума.
const TEXT_SCALES := [1.0, 1.3, 2.0]
const TEXT_SCALE_NAMES := ["Маленький", "Средний", "Большой"]
const FS_MIN := 12
const TILE_WIDTHS := [32, 40, 48, 60, 66, 72]
const TILE_SIZE_NAMES := ["Крошечный", "Маленький", "Средний", "Крупный", "Большой", "Максимум"]
const BOT_LEVEL_NAMES := ["Лёгкий", "Средний", "Сложный", "Невозможный"]

var player_count: int = MIN_PLAYERS
var player_names: PackedStringArray = PackedStringArray()
var require_30: bool = true
var text_scale: int = 1
var tile_step: int = 5
var bot_level: int = 1
var bot_anim: bool = true
## Язык интерфейса: "ru" или "en". Хранится здесь (cfg), применяется
## через Lang.set_lang (словарь + заголовок окна).
var language: String = "ru"
## Язык ещё выбран автоматически (п. 2.14 Требований платформы): на Web
## следует за environment.i18n.lang из SDK Яндекс Игр. Любой ручной выбор
## в меню или в настройках партии выключает авто навсегда — желание
## игрока сильнее языка платформы.
var language_auto: bool = true
var player_is_bot: Array = []
var stat_games: int = 0
var stat_wins: int = 0
var stat_losses: int = 0
var _ya_pause_mute_applied := false
var _ya_prev_master_mute := false
## Облачное сохранение (SDK Яндекс Игр): настройки шлём не чаще раза
## в 5 с, финал партии и уход страницы в фон — срочно и с flush;
## загрузка — один раз при старте и повторно после авторизации.
var _cloud_load_busy := false
var _cloud_load_pending := false
var _cloud_push_dirty := false
var _cloud_push_urgent := false
var _cloud_push_inflight := false
var _cloud_push_last := 0

func _ready() -> void:
	load_settings()
	if OS.get_name() == "Android":
		DisplayServer.screen_set_orientation(DisplayServer.SCREEN_SENSOR)
	_auto_lang_from_sdk()
	cloud_load()


func _process(_delta: float) -> void:
	_sync_yandex_audio_pause()
	_cloud_push_tick()


## Пункт Яндекс Игр про звук вне фокуса: SDK шлёт game_api_pause/resume,
## мост кладёт флаг, здесь мы безопасно глушим Master и возвращаем ровно
## прежнее состояние. Если звуков нет, это no-op; если появятся — уже готово.
func _sync_yandex_audio_pause() -> void:
	if not OS.has_feature("web") or not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return
	var sdk := load(YANDEX_SDK_SCRIPT) as GDScript
	var paused := bool(sdk.platform_paused())
	var bus := AudioServer.get_bus_index("Master")
	if bus < 0:
		return
	if paused and not _ya_pause_mute_applied:
		_ya_prev_master_mute = AudioServer.is_bus_mute(bus)
		AudioServer.set_bus_mute(bus, true)
		_ya_pause_mute_applied = true
		# Страница уходит в фон: незакрытые изменения досылаем сразу.
		_cloud_push_urgent = true
	elif not paused and _ya_pause_mute_applied:
		AudioServer.set_bus_mute(bus, _ya_prev_master_mute)
		_ya_pause_mute_applied = false

## Размер шрифта: база × шкала, но не ниже читаемого минимума —
## на «Маленьком» fs(12)/fs(13) не превращаются в крошку.
func fs(base: int) -> int:
	var idx := clampi(text_scale, 0, TEXT_SCALES.size() - 1)
	return maxi(FS_MIN, int(round(base * TEXT_SCALES[idx])))


## Тот же размер, но с потолком по шкале: частые кнопки строки не должны
## расти дальше заданного индекса — иначе ряд не влезал бы в телефон.
## Потолок 1 («Средний»): на «Большом» частые кнопки такие же.
func fs_capped(base: int, cap_scale: int) -> int:
	var idx := clampi(mini(text_scale, cap_scale), 0, TEXT_SCALES.size() - 1)
	return maxi(FS_MIN, int(round(base * TEXT_SCALES[idx])))


## Тот же потолок для размеров контролов: кнопка колоды на «Большом»
## остаётся как на «Среднем» (иначе она доминирует над строкой).
func touch_capped(base: int, cap_scale: int) -> int:
	var idx := clampi(mini(text_scale, cap_scale), 0, TEXT_SCALES.size() - 1)
	return maxi(1, int(round(base * TEXT_SCALES[idx])))

## Размер интерактивного контроля (кнопки, поля ввода, переключатели).
## Растёт вместе с выбранным размером текста, чтобы пальцем было легко:
## большой шрифт бессмыслен, если кнопки по нему остались крошечными.
## Пола нет — это не текст, а размеры вроде отступов (touch(2)).
func touch(base: int) -> int:
	var idx := clampi(text_scale, 0, TEXT_SCALES.size() - 1)
	return maxi(1, int(round(base * TEXT_SCALES[idx])))

## Ширина контрола с потолком по ширине окна. Текстовая шкала растит
## ширины так же, как шрифт, а пары кнопок («Заново» + «В меню») и
## ряды лобби на большом так не влезают в 576 — ширина держим в
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

## Смена языка: словарь + заголовок + запись в cfg. Перестройку экрана
## делает вызывающий (теми же путями, что смена масштаба текста).
## Это ручной выбор — он отключает авто-язык из SDK (см. language_auto).
func set_language(code: String) -> void:
	language = "en" if code == "en" else "ru"
	language_auto = false
	Lang.set_lang(language)
	save_settings()


## Язык платформы из SDK → наша пара ru/en. Переведено два языка:
## "ru" — русский, всё остальное (en и непереведённые) — английский.
## Пусто (не Web / SDK не готов / нет поля) — "" : коллер не трогает язык.
static func map_sdk_lang(code: String) -> String:
	var c := code.strip_edges().to_lower()
	if c.is_empty():
		return ""
	return "ru" if c == "ru" else "en"


## Применяет язык платформы (только в авто-режиме). Возвращает true,
## если язык реально сменился — экран надо перестроить.
func apply_sdk_language(code: String) -> bool:
	var mapped := map_sdk_lang(code)
	if mapped.is_empty() or not language_auto or mapped == language:
		return false
	language = mapped
	Lang.set_lang(language)
	save_settings()
	return true


## Авто-язык при старте Web (п. 2.14): ждём готовности init SDK
## (ensure_sdk зовёт главное меню), читаем environment.i18n.lang и
## применяем. Вне Web / после ручного выбора — тихий no-op.
## Смена дожидается главного меню: если игрок уже в партии, язык
## применяется без перезагрузки сцены (партию не рвём, меню
## переестроится при следующем входе).
func _auto_lang_from_sdk() -> void:
	if not OS.has_feature("web") or not language_auto:
		return
	if not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return
	var sdk := load(YANDEX_SDK_SCRIPT) as GDScript
	# ~30 с: под медленным CDN init тянется дольше, чем кажется.
	for _attempt in 120:
		var ready: Dictionary = sdk.poll_sdk_ready()
		if bool(ready.get("ready", false)):
			break
		if String(ready.get("error", "")) != "":
			return  # init не удался: остаёмся на сохранённом языке
		await get_tree().create_timer(0.25).timeout
		if not language_auto:
			return  # пока ждали, игрок выбрал язык руками
	if not language_auto:
		return
	if apply_sdk_language(sdk.sdk_lang()):
		_reload_menu_if_visible()


## Перестройка после смены языка: main_menu — единственная сцена, где
## перезагрузка безопасна (это и есть стартовый экран, ради которого
## язык и применялся).
func _reload_menu_if_visible() -> void:
	var scene := get_tree().current_scene
	if scene != null and scene.scene_file_path == "res://scenes/main_menu.tscn":
		get_tree().reload_current_scene()

func set_player_count(n: int) -> void:
	player_count = clampi(n, MIN_PLAYERS, MAX_PLAYERS)
	_ensure_names()
	_ensure_bots()

func set_player_name(index: int, value: String) -> void:
	_ensure_names()
	if index >= 0 and index < player_names.size():
		var cleaned := value.strip_edges()
		if cleaned.is_empty():
			cleaned = Lang.t("Игрок %d") % (index + 1)
		player_names[index] = cleaned

func _ensure_names() -> void:
	while player_names.size() < player_count:
		player_names.append(Lang.t("Игрок %d") % (player_names.size() + 1))
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
		text_scale = clampi(int(cf.get_value("game", "text_scale", 1)), 0, TEXT_SCALES.size() - 1)
		tile_step = clampi(int(cf.get_value("game", "tile_step", 5)), 0, TILE_WIDTHS.size() - 1)
		bot_level = clampi(int(cf.get_value("game", "bot_level", 1)), 0, BOT_LEVEL_NAMES.size() - 1)
		bot_anim = bool(cf.get_value("game", "bot_anim", true))
		language = String(cf.get_value("game", "language", "ru"))
		if language != "en":
			language = "ru"
		language_auto = bool(cf.get_value("game", "language_auto", true))
		Lang.set_lang(language)
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
	cf.set_value("game", "language", language)
	cf.set_value("game", "language_auto", language_auto)
	cf.set_value("game", "player_is_bot", player_is_bot)
	cf.set_value("game", "stat_games", stat_games)
	cf.set_value("game", "stat_wins", stat_wins)
	cf.set_value("game", "stat_losses", stat_losses)
	cf.save(CFG_PATH)
	_cloud_mark_dirty()


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
	# Финал партии: досылаем в облако сразу и с flush — это последний
	# гарантированный момент, пока страница жива.
	_cloud_push_urgent = true


## --- Облачное сохранение настроек и статистики (SDK Яндекс Игр) ---

const CLOUD_PUSH_INTERVAL_MSEC := 5000


## Загрузка при старте (и повторно после авторизации Yandex ID — тогда
## данные игрока уже от аккаунта, а не от lite-ID): ждём init SDK,
## читаем блоки 'settings'/'stats', применяем и зеркалим в локальный cfg.
## Вне Web / без моста — тихий no-op. Повторный вызов во время работы
## ставится в очередь: второй заход начнётся после первого.
func cloud_load() -> void:
	if not OS.has_feature("web") or not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return
	if _cloud_load_busy:
		_cloud_load_pending = true
		return
	_cloud_load_busy = true
	await _cloud_load_step()
	_cloud_load_busy = false
	if _cloud_load_pending:
		_cloud_load_pending = false
		cloud_load()


func _cloud_load_step() -> void:
	var sdk := load(YANDEX_SDK_SCRIPT) as GDScript
	# ensure_sdk идемпотентен (сторожок __ysdkRequested): главное меню
	# зовёт своё — параллельный вызов не мешает.
	sdk.ensure_sdk()
	for _attempt in 120:
		var ready: Dictionary = sdk.poll_sdk_ready()
		if bool(ready.get("ready", false)):
			break
		if String(ready.get("error", "")) != "":
			return  # init не удался: живём на локальном cfg
		await get_tree().create_timer(0.25).timeout
	sdk.request_cloud_load()
	for _attempt in 120:
		var r: Dictionary = sdk.poll_cloud_load()
		if bool(r.get("done", false)):
			var data = r.get("data")
			if data is Dictionary and not (data as Dictionary).is_empty():
				var before := language
				apply_cloud(data)
				save_settings()
				if language != before:
					_reload_menu_if_visible()
			return
		await get_tree().create_timer(0.25).timeout


## Применение облачного блока. Настройки — облако сильнее локальных
## (это предпочтения игрока, они переживают смену устройства); ячейки
## вне диапазона зажимаем, как при чтении cfg. Статистика — поэлементный
## максимум: счётчики только растут, сыгранное офлайн не пропадает.
## Язык: ручной выбор из облака сильнее авто-языка платформы; «авто»
## из облака платформе не указывает — ей владеет environment.i18n.
func apply_cloud(data: Dictionary) -> void:
	var s = data.get("settings")
	if s is Dictionary:
		var d := s as Dictionary
		player_count = clampi(int(d.get("player_count", player_count)), MIN_PLAYERS, MAX_PLAYERS)
		require_30 = bool(d.get("require_30", require_30))
		text_scale = clampi(int(d.get("text_scale", text_scale)), 0, TEXT_SCALES.size() - 1)
		tile_step = clampi(int(d.get("tile_step", tile_step)), 0, TILE_WIDTHS.size() - 1)
		bot_level = clampi(int(d.get("bot_level", bot_level)), 0, BOT_LEVEL_NAMES.size() - 1)
		bot_anim = bool(d.get("bot_anim", bot_anim))
		var cloud_auto := bool(d.get("language_auto", language_auto))
		if not cloud_auto:
			var cloud_lang := String(d.get("language", language))
			language = "en" if cloud_lang == "en" else "ru"
			language_auto = false
			Lang.set_lang(language)
		else:
			language_auto = true
		var names = d.get("player_names")
		if names is PackedStringArray:
			player_names = names
		elif names is Array:
			player_names = PackedStringArray(names)
		var bots = d.get("player_is_bot")
		if bots is Array:
			player_is_bot = bots
	var st = data.get("stats")
	if st is Dictionary:
		var ds := st as Dictionary
		stat_games = maxi(stat_games, int(ds.get("stat_games", 0)))
		stat_wins = maxi(stat_wins, int(ds.get("stat_wins", 0)))
		stat_losses = maxi(stat_losses, int(ds.get("stat_losses", 0)))
	_ensure_names()
	_ensure_bots()


## Блоб для облака: те же поля, что и в локальном cfg.
func _cloud_blob() -> Dictionary:
	return {
		"settings": {
			"player_count": player_count,
			"require_30": require_30,
			"text_scale": text_scale,
			"tile_step": tile_step,
			"bot_level": bot_level,
			"bot_anim": bot_anim,
			"language": language,
			"language_auto": language_auto,
			"player_names": Array(player_names),
			"player_is_bot": player_is_bot,
		},
		"stats": {
			"stat_games": stat_games,
			"stat_wins": stat_wins,
			"stat_losses": stat_losses,
		},
	}


func _cloud_mark_dirty() -> void:
	if OS.has_feature("web") and ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		_cloud_push_dirty = true


## Отправка из _process: не чаще раза в 5 с; urgent (flush) — после
## партии и при уходе страницы в фон. Ошибка не съедает флаг: повтор
## придёт через интервал, пока save_settings не пометит заново.
func _cloud_push_tick() -> void:
	if not OS.has_feature("web") or not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return
	var sdk := load(YANDEX_SDK_SCRIPT) as GDScript
	if _cloud_push_inflight:
		var r: Dictionary = sdk.poll_cloud_save()
		if bool(r.get("done", false)):
			_cloud_push_inflight = false
			_cloud_push_last = Time.get_ticks_msec()
			if String(r.get("error", "")) == "":
				_cloud_push_dirty = false
			_cloud_push_urgent = false
		return
	if not _cloud_push_dirty:
		return
	var now := Time.get_ticks_msec()
	if not _cloud_push_urgent and now - _cloud_push_last < CLOUD_PUSH_INTERVAL_MSEC:
		return
	_cloud_push_inflight = true
	sdk.request_cloud_save(JSON.stringify(_cloud_blob()), _cloud_push_urgent)
