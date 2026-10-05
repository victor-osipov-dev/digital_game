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
	test_report(bridge)
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


func test_report(bridge: String) -> void:
	section("лидерборд Яндекс Игр")
	ok("имя таблицы задано константой",
		bridge.contains('const LB_NAME'), "имя должно совпадать с консолью")
	ok("есть чтение записей", bridge.contains("request_lb_entries"),
		"иначе нечего показать в лобби")
	ok("есть отчёт очков", bridge.contains("report_lb_score"),
		"иначе победы не попадут в таблицу Яндекса")
	ok("записи идут через _eval_dict",
		bridge.contains("poll_lb_entries") and bridge.contains("_eval_dict"),
		"иначе opaque-объект вместо Dictionary")
	var game := _read("res://scripts/ui/game.gd")
	ok("экран победы отчитывается", game.contains("_report_win_to_yandex()"),
		"иначе таблица Яндекса не узнает о партиях")
	var at := game.find("func _report_win_to_yandex")
	var rep := ""
	if at >= 0:
		rep = game.substr(at)
		var nx := rep.find("\nfunc ", 1)
		if nx >= 0:
			rep = rep.left(nx)
	ok("отчитываемся серверным числом, а не локальным",
		rep.contains("board_list") and rep.contains("report_lb_score"),
		"клиентское число накручивается — только me.wins с сервера")
	ok("только онлайн и только Web",
		rep.contains("_online") and rep.contains('OS.has_feature("web")'),
		"офлайн и Android в таблицу Яндекса не пишут")


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
