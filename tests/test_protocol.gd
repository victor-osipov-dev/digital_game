extends SceneTree

# Юнит-тесты границы «байты -> данные»: NetProtocol.clean / parse.
#
# Проверять тут одну вещь — что null не доживает до прикладного кода.
# Причина не косметическая: Dictionary.get(ключ, умолчание) в Godot
# возвращает null, а НЕ умолчание, если ключ есть и равен null. Дальше
# String(null) — ошибка времени выполнения, то есть падение у игрока в
# середине партии из-за того, что сервер честно прислал «уведомления нет».
# Чистка делается один раз, здесь, на границе.

var _pass := 0
var _fail := 0

func _initialize() -> void:
	print("== NetProtocol: null на границе ==")
	_parse_nulls()
	_clean_nested()
	_clean_arrays()
	_parse_realistic()
	print("== Корректные сообщения не портятся ==")
	_keeps_types()
	print("== Адреса и доверие TLS по платформам ==")
	_addrs_and_trust()
	print("")
	if _fail == 0:
		print("ТЕСТ ПРОТОКОЛА: ПРОШЛО %d" % _pass)
	else:
		print("ТЕСТ ПРОТОКОЛА: НЕ ПРОШЛО %d из %d" % [_fail, _pass + _fail])
	quit(0 if _fail == 0 else 1)


func _ok(cond: bool, what: String, extra := "") -> void:
	if cond:
		_pass += 1
		print("  ok    %s" % what)
	else:
		_fail += 1
		print("  FAIL  %s%s" % [what, "" if extra == "" else " — " + extra])


# ------------------------------------------------------------- parse

func _parse_nulls() -> void:
	# Ровно тот ответ, на котором клиент падал: уведомления нет.
	var text := '{"t":"auth.ok","token":"abc","notice":null,"user":{"nick":"Имя","nick_ci":null}}'
	var m: Variant = NetProtocol.parse(text)
	_ok(m is Dictionary, "parse отдаёт словарь")
	if not (m is Dictionary):
		return
	var d: Dictionary = m
	_ok(d.get("t") == "auth.ok", "поле без null не тронуто")
	_ok(d.get("token") == "abc", "строка не тронута")
	_ok(not d.has("notice"), "ключ со значением null убран из словаря")
	# Главное: get с умолчанием теперь честно работает.
	_ok(String(d.get("notice", "")) == "", "get(ключ, умолчание) даёт умолчание")
	_ok(not (d.get("user") as Dictionary).has("nick_ci"),
		"null убран и из вложенного словаря")
	_ok(String((d.get("user") as Dictionary).get("nick_ci", "?")) == "?",
		"во вложенном словаре умолчание тоже работает")

	# Массив целиком из null.
	var arr: Variant = NetProtocol.parse('{"a":[null,null]}')
	_ok(arr is Dictionary and (arr as Dictionary)["a"] == ["", ""],
		"null в массиве заменён пустой строкой, а не выброшен")

	# Совсем пустой объект.
	var empty: Variant = NetProtocol.parse("{}")
	_ok(empty is Dictionary and (empty as Dictionary).is_empty(), "пустой объект остаётся объектом")

	# Мусор на входе — не должно быть исключения.
	_ok(NetProtocol.parse("не json") == null, "не-JSON даёт null, а не падает")
	_ok(NetProtocol.parse("[1,2]") != null, "массив на верхнем уровне разбирается")


func _clean_nested() -> void:
	var src := {
		"a": 1,
		"b": null,
		"c": {"d": null, "e": 2, "f": {"g": null}},
		"h": [{"i": null, "j": 3}],
	}
	var out: Variant = NetProtocol.clean(src)
	var d: Dictionary = out
	_ok(d.has("a") and d.has("c") and d.has("h"), "поля без null остаются")
	_ok(not d.has("b"), "null убран на верхнем уровне")
	var c: Dictionary = d["c"]
	_ok(c.has("e") and not c.has("d"), "null убран на втором уровне")
	_ok((c["f"] as Dictionary).is_empty(), "словарь, целиком из null, остаётся пустым")
	var h0: Dictionary = (d["h"] as Array)[0]
	_ok(h0.has("j") and not h0.has("i"), "null убран внутри массива объектов")
	# Исходник не тронут: clean() не имеет права портить то, что уже в памяти.
	_ok(src.has("b") and (src["c"] as Dictionary).has("d"),
		"исходный словарь не изменяется на месте")


func _clean_arrays() -> void:
	_ok(NetProtocol.clean([null, 1, null]) == ["", 1, ""],
		"массив: null -> пустая строка, остальное на месте")
	# Числа не должны потерять разрядность при проходе через clean.
	var nums: Variant = NetProtocol.clean([1, 2, 3])
	_ok((nums as Array)[0] == 1 and (nums as Array)[2] == 3, "целые числа целы")
	_ok(NetProtocol.clean("строка") == "строка", "строка на месте")
	_ok(NetProtocol.clean(7) == 7, "число на месте")
	_ok(NetProtocol.clean(true) == true, "логическое значение на месте")


# ------------------------------------------------- настоящий ответ сервера

func _parse_realistic() -> void:
	# Ответ rooms.list, каким его реально собирает сервер: пароль наружу не
	# отдаётся, hasPassword — булево, всё остальное — числа.
	var text := '{"t":"rooms.list","rooms":[{"code":"ABCDE","name":"Тест",' \
		+ '"seats":2,"filled":1,"hasPassword":false}],"server":{"id":"srv-ru"}}'
	var m: Variant = NetProtocol.parse(text)
	_ok(m is Dictionary, "список комнат разбирается")
	if not (m is Dictionary):
		return
	var rooms: Array = (m as Dictionary)["rooms"]
	_ok(rooms.size() == 1, "комната на месте")
	var room: Dictionary = rooms[0]
	_ok(int(room["seats"]) == 2, "числа приходят числами (Godot отдаёт float)")
	# Ровно то место, где раньше падало: hasPassword == false, а не null.
	_ok(room["hasPassword"] is bool and room["hasPassword"] == false,
		"hasPassword — логическое значение, а не null")


func _keeps_types() -> void:
	# clean() не имеет права превращать ноль в «нет значения».
	var d: Dictionary = NetProtocol.clean({"zero": 0, "empty": "", "no": false, "f": 0.0})
	_ok(d.has("zero") and d["zero"] == 0, "ноль остаётся нулём")
	_ok(d.has("empty") and d["empty"] == "", "пустая строка остаётся")
	_ok(d.has("no") and d["no"] == false, "false остаётся false")
	_ok(d.has("f") and is_equal_approx(d["f"], 0.0), "0.0 остаётся числом")
	# ok_types: добавление LOBBY_OPEN не должно ломать таблицу ответов.
	var t := NetProtocol.ok_types(NetProtocol.LOBBY_OPEN)
	_ok(t.has(NetProtocol.AUTH_OK) and t.has(NetProtocol.AUTH_ERR),
		"наблюдательский вход ждёт auth.ok или auth.err")
	_ok(NetProtocol.ok_types(NetProtocol.ROOMS_LIST).has(NetProtocol.ROOMS_LIST_S2C),
		"запрос списка комнат ждёт rooms.list")
	# Идентификаторы команд на клиенте и на сервере обязаны совпадать,
	# иначе наблюдательский вход уйдёт в никуда.
	_ok(NetProtocol.LOBBY_OPEN == "lobby.open", "lobby.open написан одинаково")
	_ok(NetProtocol.YA_LOGIN == "auth.ya", "auth.ya написан одинаково")


## Web-сборка ходит на те же серверы по DNS-именам (браузер не прощает
## самоподписанные сертификаты), остальные — по голым IP с пинами.
## DNS-имена сверяются системным корнем — зашитый сертификат им не нужен.
func _addrs_and_trust() -> void:
	var web: Array = Servers.builtin_for(true)
	var mob: Array = Servers.builtin_for(false)
	_ok(web.size() == 2 and mob.size() == 2, "по два сервера на платформу")
	var ru_web := {}
	var ru_mob := {}
	for e in web:
		if String((e as Dictionary).get("id", "")) == "srv-ru":
			ru_web = e
	for e in mob:
		if String((e as Dictionary).get("id", "")) == "srv-ru":
			ru_mob = e
	_ok(String(ru_web.get("host", "")) == "rudigitalgame.fimdi.ru", "web идёт по DNS")
	_ok(String(ru_mob.get("host", "")) == "85.209.2.116", "остальные — по IP")
	_ok(not Certs.is_ip_host("rudigitalgame.fimdi.ru"), "DNS — не IP")
	_ok(Certs.is_ip_host("85.209.2.116"), "IP опознаётся")
	_ok(not Certs.is_ip_host(""), "пусто — не IP")
	_ok(not Certs.is_ip_host("1.2.3.500"), "мусор — не IP")
	_ok(Certs.missing_in([{"id": "srv-ru", "host": "rudigitalgame.fimdi.ru"}]).is_empty(),
		"DNS не требует зашитого сертификата")
