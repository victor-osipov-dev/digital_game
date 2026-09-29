extends SceneTree

# Сверка API с той версией движка, на которой реально запущена игра.
#
# Смысл: названия методов и констант легко остаться от другой версии
# или заменить по памяти, и тогда поломка всплывёт у игрока в сети,
# а не при сборке. Здесь каждое имя проверяется у движка.
#
# Проверяются ровно те имена, на которых держится сетевой слой и
# вёрстка: ровно те, что использует проект.
#
#     godot --headless --path . --script res://tests/check_api.gd
#
# Три способа проверки, и важно не путать их:
#   * КОНСТАНТЫ — прямой ссылкой в коде. Если константы нет, тест
#     не скомпилируется вовсе. Это самая сильная проверка.
#   * МЕТОДЫ и СВОЙСТВА — через ClassDB: их наличие проверяется
#     в рантайме, без обращения к несуществующему имени в коде.
#   * СИГНАЛЫ — отдельно: это не методы и не свойства.

var _bad := 0


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	var info := Engine.get_version_info()
	print("Godot %s" % info["string"])

	# ================================================== константы
	# Просто обращаемся к ним. Не скомпилировалось — имя не того
	# API или не той версии, и это ровно то, что нужно узнать.
	print("\n== константы ==")
	print("  ok  WebSocketPeer.STATE_CONNECTING = %d" % WebSocketPeer.STATE_CONNECTING)
	print("  ok  WebSocketPeer.STATE_OPEN = %d" % WebSocketPeer.STATE_OPEN)
	print("  ok  WebSocketPeer.STATE_CLOSING = %d" % WebSocketPeer.STATE_CLOSING)
	print("  ok  WebSocketPeer.STATE_CLOSED = %d" % WebSocketPeer.STATE_CLOSED)
	print("  ok  Control.PRESET_FULL_RECT = %d" % Control.PRESET_FULL_RECT)
	print("  ok  Control.PRESET_MODE_MINSIZE = %d" % Control.PRESET_MODE_MINSIZE)
	print("  ok  Control.SIZE_EXPAND_FILL = %d" % Control.SIZE_EXPAND_FILL)
	print("  ok  Control.SIZE_FILL = %d" % Control.SIZE_FILL)
	print("  ok  Control.MOUSE_FILTER_IGNORE = %d" % Control.MOUSE_FILTER_IGNORE)
	print("  ok  Control.MOUSE_FILTER_STOP = %d" % Control.MOUSE_FILTER_STOP)
	# Выравнивание живёт в ГЛОБАЛЬНОМ перечислении, а не в Control/Label.
	# Поэтому Control.VERTICAL_ALIGNMENT_CENTER не компилируется, а
	# голое VERTICAL_ALIGNMENT_CENTER — да. Путать эти два места — верный
	# способ получить ошибку компиляции на пустом месте.
	print("  ok  VERTICAL_ALIGNMENT_CENTER = %d" % VERTICAL_ALIGNMENT_CENTER)
	print("  ok  HORIZONTAL_ALIGNMENT_CENTER = %d" % HORIZONTAL_ALIGNMENT_CENTER)
	print("  ok  BoxContainer.ALIGNMENT_CENTER = %d" % BoxContainer.ALIGNMENT_CENTER)
	print("  ok  ScrollContainer.SCROLL_MODE_DISABLED = %d" % ScrollContainer.SCROLL_MODE_DISABLED)
	print("  ok  TextServer.AUTOWRAP_WORD_SMART = %d" % TextServer.AUTOWRAP_WORD_SMART)
	# Значения обязаны быть РАЗНЫМИ. Совпадение двух констант означало
	# бы, что одна из них переименовалась в алиас другой, и код вёл бы
	# себя не так, как читается.
	if WebSocketPeer.STATE_CONNECTING == WebSocketPeer.STATE_OPEN:
		_fail("состояния сокета различаются только на бумаге")
	if Control.PRESET_FULL_RECT == Control.PRESET_MODE_MINSIZE:
		_fail("пресеты раскладки различаются только на бумаге")
	if Control.SIZE_EXPAND_FILL == Control.SIZE_FILL:
		_fail("флаги размера различаются только на бумаге")

	# ================================================== методы
	print("\n== методы ==")
	for m in ["connect_to_url", "poll", "get_ready_state", "get_close_code",
			"get_close_reason", "send_text", "get_available_packet_count",
			"get_packet", "close"]:
		_method("WebSocketPeer", m)
	_method("TLSOptions", "client")
	# Ровно эти четыре есть у X509Certificate в 4.7. Имён вроде
	# load_from_buffer не существует — читать сертификат приходится
	# именно load_from_string, и certs.gd так и делает.
	for m in ["load", "load_from_string", "save", "save_to_string"]:
		_method("X509Certificate", m)
	for pair in [["Control", "set_anchors_and_offsets_preset"],
			["Control", "get_combined_minimum_size"],
			["Control", "get_viewport_rect"],
			["Control", "add_theme_font_size_override"],
			["Control", "add_theme_constant_override"],
			["Control", "add_theme_color_override"],
			["Control", "add_theme_stylebox_override"],
			["MarginContainer", "add_theme_constant_override"],
			["ScrollContainer", "get_h_scroll_bar"],
			["ScrollContainer", "get_v_scroll_bar"],
			["StyleBoxFlat", "set_corner_radius_all"],
			["StyleBoxFlat", "set_border_width_all"],
			["OptionButton", "add_item"],
			["OptionButton", "set_item_id"],
			["OptionButton", "get_item_id"],
			["OptionButton", "get_item_count"],
			["OptionButton", "select"],
			["OptionButton", "get_popup"],
			["Timer", "set_wait_time"],
			["Timer", "set_one_shot"],
			["SceneTree", "create_timer"],
			["SceneTree", "change_scene_to_file"],
			["Window", "set_content_scale_size"]]:
		_method(String(pair[0]), String(pair[1]))

	# ================================================== свойства
	print("\n== свойства ==")
	# Свойство, а не метод. В 3.x было set_placeholder_text(),
	# в 4.x осталось только поле — и это самая частая замена
	# при переносе старого кода.
	_prop("LineEdit", "placeholder_text")
	_prop("LineEdit", "secret")
	# То же с fit_content: в 3.x метода не было вовсе, в 4.x поле.
	_prop("RichTextLabel", "fit_content")
	_prop("WebSocketPeer", "inbound_buffer_size")
	_prop("WebSocketPeer", "outbound_buffer_size")
	_prop("Timer", "wait_time")
	_prop("Timer", "one_shot")
	_prop("Control", "custom_minimum_size")
	_prop("Control", "size_flags_horizontal")
	_prop("Control", "visible")
	_prop("Control", "mouse_filter")
	_prop("Control", "theme_type_variation")
	_prop("OptionButton", "selected")
	_prop("CheckBox", "button_pressed")

	# ================================================== сигналы
	print("\n== сигналы ==")
	# Сигнал — не метод и не свойство; забыть про это — типичная
	# ошибка, и выглядит она как «Null instance».
	_signal("Timer", "timeout")
	_signal("Button", "pressed")
	_signal("Button", "toggled")
	_signal("CheckBox", "toggled")
	_signal("OptionButton", "item_selected")
	_signal("Node", "ready")
	_signal("SceneTree", "process_frame")

	# ================================================== свои скрипты
	# class_name обязан существовать: иначе ссылка на класс не
	# компилируется, и виноват окажется тот экран, где её впервые
	# коснулись, а не тот, где class_name стёрли.
	print("\n== class_name ==")
	for pair in [["Deck", "res://scripts/core/deck.gd"],
			["GameState", "res://scripts/core/game_state.gd"],
			["Rules", "res://scripts/core/rules.gd"],
			["Tile", "res://scripts/core/tile.gd"],
			["TurnPlanner", "res://scripts/core/turn_planner.gd"],
			["Certs", "res://scripts/net/certs.gd"],
			["NetProtocol", "res://scripts/net/protocol.gd"],
			["Servers", "res://scripts/net/servers.gd"],
			["Session", "res://scripts/net/session.gd"],
			["ViewBuilder", "res://scripts/net/view_builder.gd"],
			["DropLayer", "res://scripts/ui/drop_layer.gd"],
			["FlowTiles", "res://scripts/ui/flow_tiles.gd"],
			["OnlineLobby", "res://scripts/ui/online_lobby.gd"],
			["RowBlock", "res://scripts/ui/row_block.gd"],
			["TileView", "res://scripts/ui/tile_view.gd"]]:
		_class_name(String(pair[0]), String(pair[1]))

	# ================================================== сборка
	print("\n== что должно попасть в PCK ==")
	for pair in [["автозагрузка Settings", "res://scripts/core/settings.gd"],
			["автозагрузка Net", "res://scripts/net/net.gd"]]:
		_file(String(pair[0]), String(pair[1]))
	_autoload_declared("Settings")
	_autoload_declared("Net")
	for scene in ["res://scenes/main_menu.tscn", "res://scenes/game.tscn"]:
		_file("сцена", scene)

	# Сертификаты: читаются ровно тем способом, каким читает игра.
	# Только .crt проходит импорт и потому гарантированно оказывается
	# внутри PCK; .pem мимо импорта проходит и в сборку не попадает.
	print("\n== сертификаты ==")
	for id in ["85-209-2-116", "31-56-196-114"]:
		var path := "res://certs/%s.crt" % id
		if not ResourceLoader.exists(path):
			_fail("%s не прошёл импорт и в сборку не попадёт" % path)
			continue
		var cert: X509Certificate = load(path)
		if cert == null:
			_fail("%s не читается" % path)
			continue
		var pem := cert.save_to_string().replace("\u0000", "")
		if pem.is_empty() or not pem.begins_with("-----BEGIN CERTIFICATE-----"):
			_fail("%s прочитан, но это не сертификат" % path)
			continue
		# Длина обязана совпасть с файлом на диске до байта. Короткий
		# сертификат не хуже длинного вслепую: обрезанный ключ хуже
		# отсутствующего — ошибка проверки TLS будет выглядеть как
		# «сервер недоступен», и чинить её будут не там.
		var on_disk := FileAccess.get_file_as_string(path).length()
		if pem.length() != on_disk:
			_fail("%s: в сборке %d байт, на диске %d" % [path, pem.length(), on_disk])
			continue
		print("  ok  %s, %d байт PEM, байт в байт" % [path, pem.length()])

	print("")
	if _bad == 0:
		print("API СООТВЕТСТВУЕТ ВЕРСИИ: расхождений нет")
		quit(0)
	else:
		print("API НЕ СООТВЕТСТВУЕТ: расхождений %d" % _bad)
		quit(1)


# ------------------------------------------------------------------ проверки

func _method(cls: String, name: String) -> void:
	if not ClassDB.class_exists(cls):
		_fail("класса %s нет" % cls)
		return
	if not ClassDB.class_has_method(cls, name):
		_fail("%s.%s() не существует" % [cls, name])


func _prop(cls: String, name: String) -> void:
	if not ClassDB.class_exists(cls):
		_fail("класса %s нет" % cls)
		return
	# Отдельного class_has_property в движке нет, свойства берутся
	# из списка — так же, как их видит редактор. Список строим
	# ВМЕСТЕ с унаследованными: visible объявлен не в Control, а в
	# CanvasItem, и без предков его не найти — проверка молча стала бы
	# проверкой несуществующего свойства.
	for entry in ClassDB.class_get_property_list(cls, false):
		if String(entry["name"]) == name:
			return
	_fail("%s.%s (свойство) не существует" % [cls, name])


func _signal(cls: String, name: String) -> void:
	if not ClassDB.class_exists(cls):
		_fail("класса %s нет" % cls)
		return
	if not ClassDB.class_has_signal(cls, name):
		_fail("%s.%s (сигнал) не существует" % [cls, name])


func _class_name(want: String, path: String) -> void:
	var s = load(path)
	if s == null:
		_fail("%s не читается" % path)
		return
	var got := String(s.get_global_name())
	if got != want:
		_fail("%s объявляет class_name %s, а ждали %s" % [path, got, want])


func _file(what: String, path: String) -> void:
	if not FileAccess.file_exists(path):
		_fail("%s: нет файла %s" % [what, path])


func _autoload_declared(name: String) -> void:
	if not ProjectSettings.has_setting("autoload/" + name):
		_fail("автозагрузка %s не объявлена в project.godot" % name)


func _fail(text: String) -> void:
	print("  ПРОВАЛ %s" % text)
	_bad += 1
