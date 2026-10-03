class_name ViewBuilder
extends RefCounted
const Lang := preload("res://scripts/core/lang.gd")

# Сборка GameState из того, что прислал сервер.
#
# Сервер — единственный источник правды. Клиент не досчитывает чужие
# руки, не додумывает колоду и не решает, чей ход: всё это приезжает
# готовым. Наш ход отсюда тоже НЕ вычисляется («ходит ли тот, у кого
# рука»), а берётся из поля my_turn — потому что ход и наличие руки
# у сервера разные вещи, и выводить одно из другого нельзя.
#
# Фишки приходят номерами. Расшифровка номера — таблица из приветствия
# сервера: один раз на соединение, дальше кэш.

# id -> Tile. Кэш общий на всё приложение.
static var _tiles: Dictionary = {}
static var _catalog_size := 0
static var _unknown := {}


## Запоминает каталог фишек из приветствия сервера.
static func set_catalog(list: Array) -> void:
	_tiles.clear()
	_unknown.clear()
	for raw in list:
		if not (raw is Dictionary):
			continue
		var d: Dictionary = raw
		var id := int(d.get("id", 0))
		if id <= 0:
			continue
		_tiles[id] = Tile.new(id, int(d.get("color", 0)),
			int(d.get("value", 1)), bool(d.get("is_joker", false)))
	_catalog_size = _tiles.size()


static func catalog_ready() -> bool:
	return _catalog_size > 0


## Фишка по номеру. Возвращает ОДИН И ТОТ ЖЕ объект на весь сеанс:
## состояние партии сравнивает фишки по ссылке (можно ли забрать назад
## ту, что выложил сам), и новый объект на каждый вызов сломал бы эту
## проверку тихо и незаметно.
static func tile(id: int) -> Tile:
	if _tiles.has(id):
		return _tiles[id]
	# Каталог не пришёл или номер неизвестен. Подставляем заглушку и
	# ругаемся один раз на номер: лучше показать партию с неверной
	# фишкой, чем уронить её совсем.
	if not _unknown.has(id):
		_unknown[id] = true
		push_error(Lang.t("сервер прислал фишку №%d, которой нет в каталоге (%d шт.known)")
			% [id, _catalog_size])
	var color := 0 if id <= 0 or id > 4 else (id - 1) % 4
	var value := 1
	return Tile.new(id, color, value, false)


## Собирает состояние партии из представления game.state.
static func build(view: Dictionary) -> GameState:
	var g := GameState.new()
	g.local_seat = int(view.get("you", -1))
	g.require_30 = bool(view.get("require30", true))
	g.first_turn = bool(view.get("firstTurn", true))
	g.finished = bool(view.get("finished", false))
	g.winner = int(view.get("winner", -1))
	g.deck_count_override = maxi(0, int(view.get("deckCount", 0)))

	# Числа из JSON приходят ВСЕГДА дробными: разбирает их один и тот же
	# парсер Godot, и «3» он тоже отдаёт как 3.0. Поэтому int() стоит на
	# каждом числе, а не «где понадобится» — иначе номер фишки 15.0 не
	# найдётся в каталоге, а сравнение с целым даст «не равно».
	#
	# Кто сколько фишек держит. Чужие руки нам не присылают — только счёт.
	g.hand_count_override.clear()
	g.connected.clear()
	for raw in view.get("players", []):
		if not (raw is Dictionary):
			continue
		var d: Dictionary = raw
		var player := GameState.Player.new(String(d.get("nick", "?")))
		player.is_bot = bool(d.get("isBot", false))
		g.players.append(player)
		g.hand_count_override.append(maxi(0, int(d.get("handCount", 0))))
		g.connected.append(bool(d.get("connected", true)))

	# Зажимаем по ЧИСЛУ ИГРОКОВ, а не по заявленным местам: если сервер
	# прислал игроков меньше, чем мест, current обязан остаться в пределах
	# того массива, который мы реально построили. Иначе отрисовка уедет
	# читать чужое место, которого нет.
	g.current = 0 if g.players.is_empty() \
		else clampi(int(view.get("current", 0)), 0, g.players.size() - 1)

	# Наша рука — единственная настоящая.
	var me := g.local_seat
	if me >= 0 and me < g.players.size():
		var my_hand: Array = (g.players[me] as GameState.Player).hand
		for id in view.get("hand", []):
			my_hand.append(tile(int(id)))
		Tile.sort_tiles(my_hand)

	# Стол публичен целиком.
	var max_row_id := 0
	for raw in view.get("table", []):
		if not (raw is Dictionary):
			continue
		var d: Dictionary = raw
		var row := GameState.Row.new(int(d.get("id", 0)))
		for id in d.get("tileIds", []):
			row.tiles.append(tile(int(id)))
		g.table.append(row)
		max_row_id = maxi(max_row_id, row.id)
	g.reserve_row_ids(max_row_id)

	# Что мы выложили в этом ходу. Сервер знает, а без этого подсветка
	# «свои ходы» пропала бы после переподключения.
	for id in view.get("turnPlaced", []):
		g.turn_placed.append(tile(int(id)))
	for id in view.get("lastTurn", []):
		g.last_turn_tile_ids.append(int(id))

	# Снимок поворота: откат назад по серверу и должен откатить к этому
	# состоянию, а не к пустому столу.
	g.take_turn_snapshot()
	return g
