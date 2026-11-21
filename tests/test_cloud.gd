extends SceneTree

# Облачное сохранение через SDK Яндекс Игр: слияние настроек и
# статистики, зажатие диапазонов, язык (ручной выбор сильнее авто),
# форма блоба и наличие моста getData/setData. Вне Web мост отвечает
# nosdk — это и проверяем: весь сьют идёт на десктопе.
#
#     godot --headless --path . --script res://tests/test_cloud.gd

const Lang := preload("res://scripts/core/lang.gd")
const YSDK_PATH := "res://scripts/platform/yandex_sdk.gd"

var fails := 0
var total := 0
var _snap: Dictionary = {}

func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)

func _boot() -> void:
	root.size = Vector2i(576, 1024)
	var settings := root.get_node_or_null("Settings")
	if settings == null:
		printerr("FAIL  Settings autoload отсутствует")
		quit(1)
		return
	_snapshot(settings)
	test_nosdk_polls()
	test_stats_max(settings)
	test_settings_win(settings)
	test_language_rules(settings)
	test_blob(settings)
	test_sources()
	_restore(settings)
	if fails == 0:
		print("\nОБЛАЧНОЕ СОХРАНЕНИЕ: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nОБЛАЧНОЕ СОХРАНЕНИЕ: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)


## Вне Web мост не установлен: опросы сразу кончаются с nosdk —
## коллеры загрузки и отправки честно выходят, ничего не висит.
func test_nosdk_polls() -> void:
	section("вне Web мост отвечает nosdk")
	var sdk = load(YSDK_PATH)
	var l: Dictionary = sdk.poll_cloud_load()
	ok("poll_cloud_load: done+nosdk",
		bool(l.get("done", false)) and String(l.get("error", "")) == "nosdk", str(l))
	var s: Dictionary = sdk.poll_cloud_save()
	ok("poll_cloud_save: done+nosdk",
		bool(s.get("done", false)) and String(s.get("error", "")) == "nosdk", str(s))


## Счётчики только растут: максимум поэлементный, нули облака не
## обнуляют сыгранное офлайн.
func test_stats_max(settings) -> void:
	section("статистика: поэлементный максимум")
	settings.stat_games = 10
	settings.stat_wins = 4
	settings.stat_losses = 3
	settings.apply_cloud({"stats": {"stat_games": 5, "stat_wins": 9, "stat_losses": 1}})
	ok("игр: локальных больше", settings.stat_games == 10, str(settings.stat_games))
	ok("побед: облако больше", settings.stat_wins == 9, str(settings.stat_wins))
	ok("поражений: локальных больше", settings.stat_losses == 3, str(settings.stat_losses))
	settings.apply_cloud({"stats": {"stat_games": 0, "stat_wins": 0, "stat_losses": 0}})
	ok("нули облака не обнуляют",
		settings.stat_games == 10 and settings.stat_wins == 9 and settings.stat_losses == 3)


## Настройки — облако сильнее локальных; ячейки вне диапазона
## зажимаются так же, как при чтении cfg.
func test_settings_win(settings) -> void:
	section("настройки: облако сильнее, диапазоны зажаты")
	settings.player_count = 2
	settings.text_scale = 1
	settings.tile_step = 0
	settings.bot_level = 1
	settings.require_30 = true
	settings.bot_anim = true
	settings.player_names = PackedStringArray(["Игрок 1", "Игрок 2"])
	settings.player_is_bot = [false, false]
	settings.apply_cloud({"settings": {
		"player_count": 2,
		"text_scale": 0,
		"tile_step": 99,
		"bot_level": 99,
		"require_30": false,
		"bot_anim": false,
		"player_names": ["Облачный", "Второй"],
		"player_is_bot": [true, false],
	}})
	ok("text_scale облако применил", settings.text_scale == 0, str(settings.text_scale))
	ok("tile_step зажат", settings.tile_step == 5, str(settings.tile_step))
	ok("bot_level зажат", settings.bot_level == 3, str(settings.bot_level))
	ok("require_30 облако применил", settings.require_30 == false)
	ok("bot_anim облако применил", settings.bot_anim == false)
	ok("имена облака применились",
		settings.player_names == PackedStringArray(["Облачный", "Второй"]),
		str(settings.player_names))
	ok("боты облака применились", settings.player_is_bot == [true, false])
	settings.apply_cloud({"settings": {"player_count": 99}})
	ok("player_count зажат", settings.player_count == 5, str(settings.player_count))


## Язык: ручной выбор из облака сильнее авто-языка платформы;
## «авто» из облака платформе не указывает — язык не трогаем.
func test_language_rules(settings) -> void:
	section("язык: ручной выбор сильнее авто")
	settings.language = "ru"
	settings.language_auto = true
	Lang.set_lang("ru")
	settings.apply_cloud({"settings": {"language": "en", "language_auto": false}})
	ok("ручной выбор облака применён",
		settings.language == "en" and not settings.language_auto,
		"%s/%s" % [str(settings.language), str(settings.language_auto)])
	ok("словарь переключился", Lang.t("Начать") == "Start", Lang.t("Начать"))
	settings.language = "ru"
	settings.language_auto = false
	Lang.set_lang("ru")
	settings.apply_cloud({"settings": {"language": "en", "language_auto": true}})
	ok("авто из облака не диктует язык",
		settings.language == "ru" and settings.language_auto,
		"%s/%s" % [str(settings.language), str(settings.language_auto)])


## Блоб повторяет поля cfg, имена — обычный Array (JSON принимает).
func test_blob(settings) -> void:
	section("блоб для облака")
	settings.player_names = PackedStringArray(["A"])
	var blob: Dictionary = settings._cloud_blob()
	ok("два блока", blob.has("settings") and blob.has("stats"), str(blob.keys()))
	var s: Dictionary = blob["settings"]
	ok("настройки: поля",
		s.has("player_count") and s.has("text_scale") and s.has("bot_anim")
			and s.has("language") and s.has("language_auto") and s.has("player_names"),
		str(s.keys()))
	ok("имена — обычный Array (JSON)", s.get("player_names") is Array,
		str(typeof(s.get("player_names"))))
	ok("в настройках нет статистики", not s.has("stat_games"))
	var st: Dictionary = blob["stats"]
	ok("статистика: счётчики",
		st.has("stat_games") and st.has("stat_wins") and st.has("stat_losses"),
		str(st.keys()))
	ok("JSON сериализуется", not JSON.stringify(blob).is_empty())


## Мост обязан писать и читать данные игрока, а вызовы — стоять в
## settings (старт и сохранение) и в лобби (после входа).
func test_sources() -> void:
	section("мост и точки вызова на месте")
	var sdk_src := _read_text(YSDK_PATH)
	ok("getData по ключам settings/stats",
		sdk_src.contains("getData(['settings','stats'])"))
	ok("setData блоба с flush", sdk_src.contains("return p.setData(blob,"))
	var st_src := _read_text("res://scripts/core/settings.gd")
	ok("загрузка при старте", st_src.contains("cloud_load()"))
	ok("save_settings помечает облако", st_src.contains("_cloud_mark_dirty()"))
	ok("финал партии — срочно", st_src.contains("_cloud_push_urgent = true"))
	var lobby_src := _read_text("res://scripts/ui/online_lobby.gd")
	ok("после входа облако перечитывается", lobby_src.contains("Settings.cloud_load()"))


func _snapshot(settings) -> void:
	_snap = {
		"player_count": settings.player_count,
		"require_30": settings.require_30,
		"text_scale": settings.text_scale,
		"tile_step": settings.tile_step,
		"bot_level": settings.bot_level,
		"bot_anim": settings.bot_anim,
		"language": settings.language,
		"language_auto": settings.language_auto,
		"player_names": settings.player_names,
		"player_is_bot": settings.player_is_bot,
		"stat_games": settings.stat_games,
		"stat_wins": settings.stat_wins,
		"stat_losses": settings.stat_losses,
	}


func _restore(settings) -> void:
	settings.player_count = _snap["player_count"]
	settings.require_30 = _snap["require_30"]
	settings.text_scale = _snap["text_scale"]
	settings.tile_step = _snap["tile_step"]
	settings.bot_level = _snap["bot_level"]
	settings.bot_anim = _snap["bot_anim"]
	settings.language = _snap["language"]
	settings.language_auto = _snap["language_auto"]
	settings.player_names = _snap["player_names"]
	settings.player_is_bot = _snap["player_is_bot"]
	settings.stat_games = _snap["stat_games"]
	settings.stat_wins = _snap["stat_wins"]
	settings.stat_losses = _snap["stat_losses"]
	Lang.set_lang(settings.language)


func _read_text(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var text := f.get_as_text()
	f.close()
	return text

func section(name: String) -> void:
	print("\n== %s ==" % name)

func ok(msg: String, cond: bool, detail: String = "") -> void:
	total += 1
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		var line := "FAIL  " + msg
		if not detail.is_empty():
			line += " | " + detail
		printerr(line)
