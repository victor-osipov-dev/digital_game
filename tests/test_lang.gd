extends SceneTree

# ==============================================================
#  Локализация (Lang): русский — язык исходников, английский —
#  словарь. В русской локали t() возвращает вход как есть, поэтому
#  весь остальной сьют идёт без изменений; здесь проверяем словарь
#  и сквозную работу английского на главном меню.
#
#     godot --headless --path . --script res://tests/test_lang.gd
# ==============================================================

const Lang := preload("res://scripts/core/lang.gd")

var fails := 0
var total := 0
var _saved_lang := "ru"
var _state := [false, false]

func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)

func _boot() -> void:
	root.size = Vector2i(576, 1024)
	var settings := root.get_node_or_null("Settings")
	if settings != null:
		_saved_lang = String(settings.language)
	test_ru_identity()
	test_en_table()
	test_en_helpers()
	test_en_menu()
	test_boot_title()
	# Возвращаем язык: сьют дальше идёт на русском по умолчанию.
	Lang.set_lang(_saved_lang)
	if settings != null:
		settings.set_language(_saved_lang)
	if fails == 0:
		print("\nЛОКАЛИЗАЦИЯ: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nЛОКАЛИЗАЦИЯ: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)

## В русской локали перевод — тождество (старые тесты и тексты целы).
func test_ru_identity() -> void:
	section("русская локаль — тождество")
	Lang.set_lang("ru")
	ok("название", Lang.app_name() == "Антисклероз")
	ok("кнопка", Lang.t("Начать") == "Начать")
	ok("шаблон с числом", (Lang.t("Стр. %d из %d") % [1, 2]) == "Стр. 1 из 2")
	ok("неизвестное не трогаем", Lang.t("Выдуманная строка") == "Выдуманная строка")

## Английский словарь: наличие, непустота, отличие от ключа.
func test_en_table() -> void:
	section("английский словарь полон")
	Lang.set_lang("en")
	ok("название", Lang.app_name() == "Anti-Sclerosis")
	var keys: Array = Lang.all_keys()
	var empty: Array = []
	var same: Array = []
	for k in keys:
		var ks := String(k)
		if not Lang.has_key(ks):
			continue
		var v := Lang.t(ks)
		if v.is_empty():
			empty.append(ks)
		elif v == ks:
			same.append(ks)
	ok("без пустых переводов", empty.is_empty(), str(empty.slice(0, 3)))
	ok("без тождественных", same.is_empty(), str(same.slice(0, 3)))
	ok("кнопка", Lang.t("Начать") == "Start")
	ok("подсказка", Lang.t("Подсказка") == "Hint")
	ok("шаблон", (Lang.t("Стр. %d из %d") % [1, 2]) == "Page 1 of 2")
	ok("ошибка правил", Lang.t("Стол в невалидном состоянии") == "Table is invalid")
	ok("строка сервера", Lang.t("Неверный логин или пароль") == "Wrong login or password")
	ok("комната сервера", Lang.t("В комнате нет свободных мест") == "Room is full")
	ok("цвета", Lang.t("красный") == "red" and Lang.t("фиолетовый") == "purple")
	ok("неизвестное — как есть", Lang.t("Выдуманная строка") == "Выдуманная строка")
	ok("префикс сервера", Lang.t("Неизвестная команда game.commit") == "Unknown command game.commit")

## Вспомогательные функции в обеих локалях.
func test_en_helpers() -> void:
	section("формы и списки")
	Lang.set_lang("en")
	ok("tile 1", Lang.card_word(1) == "tile")
	ok("tiles 5", Lang.card_word(5) == "tiles")
	ok("имена", list_eq(Lang.names(["Средний", "Невозможный"]), ["Medium", "Impossible"]))
	Lang.set_lang("ru")
	ok("карточку 1", Lang.card_word(1) == "карточку")
	ok("карточки 3", Lang.card_word(3) == "карточки")
	ok("карточек 5", Lang.card_word(5) == "карточек")
	ok("имена ru", list_eq(Lang.names(["Средний"]), ["Средний"]))

## Сквозная проверка: главное меню строится на английском.
func test_en_menu() -> void:
	section("меню на английском")
	Lang.set_lang("en")
	var packed := load("res://scenes/main_menu.tscn") as PackedScene
	if packed == null:
		printerr("FAIL  main_menu.tscn не читается")
		fails += 1
		total += 1
		return
	var menu := packed.instantiate()
	root.add_child(menu)
	await process_frame
	await process_frame
	var title_label := menu.get("_menu_title") as Label
	ok("заголовок Anti-Sclerosis",
		title_label != null and title_label.text == "Anti-Sclerosis")
	ok("окно переименовано", Lang.last_title == "Anti-Sclerosis")
	_state = [false, false]
	_collect_buttons(menu)
	ok("кнопка Start на месте", _state[0])
	ok("кнопка How to play на месте", _state[1])
	root.remove_child(menu)
	menu.free()
	Lang.set_lang("ru")

## Заголовок вкладки после перезагрузки: стартовые вызовы apply_title
## из _ready в Web теряются (движок позже выставляет название из shell),
## поэтому заголовок дублируется прямо в DOM и применяется повторно
## после старта. Вне Web прямой записи нет — только DisplayServer.
func test_boot_title() -> void:
	section("заголовок вкладки переживает перезагрузку")
	Lang.set_lang("ru")
	ok("русское название", Lang.last_title == "Антисклероз")
	Lang.set_lang("en")
	ok("английское название", Lang.last_title == "Anti-Sclerosis")
	var lang_src := _read_text("res://scripts/core/lang.gd")
	ok("прямая запись document.title на Web",
		lang_src.contains("document.title="))
	var menu_src := _read_text("res://scripts/ui/main_menu.gd")
	ok("повтор после старта в главном меню",
		menu_src.contains("_reapply_title_boot()"))


func _read_text(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var text := f.get_as_text()
	f.close()
	return text

func _collect_buttons(node: Node) -> void:
	if node is Button:
		if (node as Button).text == "Start":
			_state[0] = true
		if (node as Button).text == "How to play":
			_state[1] = true
	for child in node.get_children():
		_collect_buttons(child)

func list_eq(a: PackedStringArray, b: Array) -> bool:
	if a.size() != b.size():
		return false
	for i in a.size():
		if String(a[i]) != String(b[i]):
			return false
	return true

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
