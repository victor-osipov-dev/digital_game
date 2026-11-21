extends SceneTree

# Проверка, что все скрипты проекта разбираются.
#
# `--headless --quit` компилирует только те файлы, до которых дошёл
# главный сценарный путь, а остальное молча оставляет сломанным до
# первого открытия. Здесь мы грузим каждый скрипт явно.
#
#     godot --headless --path . --script res://tests/test_parse.gd

const ROOTS := ["res://scripts", "res://tests"]

var total := 0
var bad: Array = []


func _initialize() -> void:
	for root in ROOTS:
		_walk(root)
	if bad.is_empty():
		print("ВСЕ СКРИПТЫ РАЗБИРАЮТСЯ (%d)" % total)
		quit(0)
		return
	printerr("НЕ РАЗОБРАЛИСЬ (%d из %d):" % [bad.size(), total])
	for path in bad:
		printerr("  " + path)
	quit(1)


func _walk(dir_path: String) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		printerr("нет каталога: " + dir_path)
		return
	for name in dir.get_files():
		if not name.ends_with(".gd"):
			continue
		# Служебные сценарии отладки разбирать незачем.
		if name.begins_with("_"):
			continue
		var res_path := dir_path.path_join(name)
		total += 1
		# Скрипт, который сейчас выполняется, трогать нельзя: reload()
		# пересобирает код и выбрасывает тот самый кадр, из которого мы
		# вызвали его. Godot падает на этом с segfault, а не с ошибкой.
		if res_path == self.get_script().resource_path:
			continue
		# Именно reload(), а не load(): сломанный скрипт load() тоже
		# вернёт — просто с пустым телом, и проверка молча прошла бы.
		# reload() пересобирает исходник и возвращает ошибку компиляции.
		var script := load(res_path)
		if script == null or not (script is GDScript):
			bad.append(res_path)
			continue
		if (script as GDScript).reload(true) != OK:
			bad.append(res_path)
	# Обходим подкаталоги поимённо, а не через «..»: вслепую рекурсия
	# ушла бы из проекта и начала бы сканировать сам Godot.
	for name in dir.get_directories():
		_walk(dir_path.path_join(name))
