extends SceneTree

# ==============================================================
#  Смена сцены не должна падать на отсоединённом узле.
#
#  Все вызовы change_scene_to_file в online_lobby и game достигаются
#  после await (ответ сервера, таймер, сетевой сигнал). За это время
#  сцена уже могли сменить: игрок вышел в меню, связь отвалилась и
#  клиент ушёл в main_menu. У отсоединённого узла get_tree()
#  возвращает null, и игра падала с «Cannot call method
#  'change_scene_to_file' on a null value».
#
#  Проверить это внутри одного процесса нельзя: при аварийном
#  прерывании Godot возвращает значение по умолчанию для типа
#  возврата (false) — ровно то же, что guard возвращает штатно.
#  Различить их можно только по ошибке в stderr, поэтому тест
#  запускает дочерний процесс и читает его вывод.
#
#  Запуск:
#     godot --headless --path . --script res://tests/check_scene_guard.gd
# ==============================================================

const CHILD := "user://_scene_guard_child.gd"

var fails := 0


func check(cond: bool, msg: String) -> void:
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		printerr("FAIL  " + msg)


func _initialize() -> void:
	_run_child()
	if fails == 0:
		print("SCENE GUARD CHECK PASSED")
		quit(0)
	else:
		printerr("SCENE GUARD CHECK: %d FAILED" % fails)
		quit(1)


## Пишет и запускает дочерний скрипт: он зовёт смену сцены с узла,
## которого нет в дереве, и печатает маркер. Ошибка движка в этом
## случае попадает в stderr дочернего процесса, и её видно.
func _run_child() -> void:
	var f := FileAccess.open(CHILD, FileAccess.WRITE)
	if f == null:
		check(false, "не записался дочерний скрипт")
		return
	f.store_string("""extends SceneTree
func _initialize() -> void:
	var s := load("res://scripts/ui/online_lobby.gd")
	var node = s.new()
	# Узел создан, но в дерево НЕ добавлен: ровно то состояние, в
	# котором лобби оказывается после смены сцены главного меню.
	node.call("_go_scene", "res://scenes/game.tscn")
	print("CHILD-REACHED-END")
	quit(0)
""")
	f.close()

	var exe := OS.get_executable_path()
	var args := ["--headless", "--path", ProjectSettings.globalize_path("res://"), "--script", CHILD]
	var out: Array = []
	var code := OS.execute(exe, args, out, true, false)
	var text := ""
	for chunk in out:
		text += String(chunk)

	# Ошибка движка об отсоединённом узле — ровно та строка, из-за
	# которой этот тест и написан.
	check(not text.contains("on a null value"),
		"смена сцены с отсоединённого узла не падает")
	check(not text.contains("data.tree"),
		"get_tree() у отсоединённого узла не дёргается")
	check(text.contains("CHILD-REACHED-END"),
		"дочерний скрипт досрал до конца (код %d)" % code)

	DirAccess.remove_absolute(CHILD)
