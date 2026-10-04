extends SceneTree

# ==============================================================
#  Web-shell Яндекс Игр: относительный /sdk.js в пресете и
#  загрузчик, который не затирает уже подключённый YaGames.
#
#  Регрессия на баг dev-proxy: ensure_sdk() слепо инжектил настоящий
#  SDK с CDN поверх стаба прокси → init падал с
#  «No parent to post message», игра считала себя вне Яндекс Игр.
#
#     godot --headless --path . --script res://tests/check_webshell.gd
# ==============================================================

const PRESET_PATH := "res://export_presets.cfg"
const BRIDGE_PATH := "res://scripts/platform/yandex_sdk.gd"

var fails := 0
var total := 0


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	var preset := _read(PRESET_PATH)
	var bridge := _read(BRIDGE_PATH)
	if preset.is_empty() or bridge.is_empty():
		printerr("FAIL  не читаются пресет или мост SDK")
		quit(1)
		return
	test_preset(preset)
	test_bridge(bridge)
	test_bridge_reads(bridge)
	if fails == 0:
		print("\nWEB SHELL: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nWEB SHELL: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)


func test_preset(preset: String) -> void:
	section("пресет Yandex_Web")
	ok("head_include упоминает /sdk.js",
		preset.contains("/sdk.js"), "тег потерян — прокси не отдаст стаб")
	ok("путь относительный, без CDN в пресете",
		not preset.contains("yandex.ru/games/sdk"),
		"абсолютный URL ломает dev-proxy и прод-заливку архивом")
	ok("кастомный shell не нужен (достаточно head_include)",
		preset.contains('html/custom_html_shell=""'),
		"кто-то подключил shell — проверить тег в нём")


func test_bridge(bridge: String) -> void:
	section("загрузчик yandex_sdk.gd")
	var guard := bridge.find("window.YaGames")
	var inject := bridge.find("createElement")
	ok("есть проверка уже загруженного YaGames",
		guard >= 0, "вернётся слепая перезапись CDN-скриптом")
	ok("проверка стоит ДО инжекта скрипта",
		guard >= 0 and inject >= 0 and guard < inject,
		"порядок важен: сначала guard, потом createElement")
	ok("первый источник — относительный /sdk.js",
		bridge.contains("s.src='/sdk.js'"),
		"иначе прокси-стаб не используется")
	ok("CDN остался только запасным вариантом",
		bridge.contains("SDK_URL"), "фолбэк для устаревших сборок")


func test_bridge_reads(bridge: String) -> void:
	section("чтение объектов из JS")
	ok("опросы идут через _eval_dict",
		bridge.contains("_eval_dict"), "иначе вернётся opaque-объект")
	ok("_eval_dict крутит через JSON.stringify",
		bridge.contains("JSON.stringify"), "иначе не Dictionary")
	ok("не осталось прямых чтений объектным литералом",
		not bridge.contains('_eval("({'),
		"eval отдаёт JavaScriptObject, а не Dictionary — опросы вечно nosdk")
	ok("все пять опросов на _eval_dict",
		bridge.count("_eval_dict(") >= 6,
		"helper + ready/hint/endgame/auth/player")


func _read(path: String) -> String:
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
