class_name NetProtocol
extends RefCounted

# Зеркало server/src/protocol.js. Меняешь там — меняй здесь, иначе клиент
# перестанет понимать ответы, а расхождение обнаружится только в проде.

# --- клиент -> сервер ---------------------------------------------------
const REGISTER := "auth.register"        # {login, password, nick} -> auth.ok
const LOGIN := "auth.login"              # {login, password} -> auth.ok
const RESUME := "auth.resume"            # {token} -> auth.ok
const YA_LOGIN := "auth.ya"              # {uid, nick} -> auth.ok (только Web/Yandex ID)
# Вход только на чтение: позволяет прочитать список комнат с чужого
# сервера, не трогая состояние. Обычный вход для этого не годится —
# он перехватывает сокет игрока в комнате, и закрытие такой связи
# выбивает его из партии.
const LOBBY_OPEN := "lobby.open"        # {token} -> auth.ok
const LOGOUT := "auth.logout"
const CHANGE_PASSWORD := "auth.password" # {old, new} -> auth.ok
const CHANGE_NICK := "auth.nick"         # {nick} -> auth.ok

const SERVERS_LIST := "servers.list"
const ROOMS_LIST := "rooms.list"
const ROOM_CREATE := "room.create"       # {seats, require30, name, password} -> room.state
const ROOM_JOIN := "room.join"           # {code, password} -> room.state | game.state
const ROOM_LEAVE := "room.leave"
const ROOM_DROP := "room.drop"           # {} -> room.left (полный выход, место освобождается сразу)
const ROOM_START := "room.start"         # -> game.state | game.error
const ROOM_CHAT := "room.chat"           # зарезервировано

const QUICK_JOIN := "quick.join"
const QUICK_LEAVE := "quick.leave"

const GAME_COMMIT := "game.commit"       # {ops:[...]} -> game.state | game.error
const GAME_DRAW := "game.draw"
const GAME_SKIP := "game.skip"
const GAME_REJOIN := "game.rejoin"
# Превью хода: игрок перебирает, куда положить/убрать фишку. Без ответа:
# сервер пересылает остальным соперникам. kind: clear | into | new | back.
const GAME_PEEK := "game.peek"           # {tile, kind, row?, index?, at?}
# Черновик стола: ВЕСЬ стол автора после каждой локальной раскладки, чтобы
# соперники видели все выложенные фишки (серыми) ещё до commit. Без ответа.
# Формат rows совпадает с rows в op "set_table" у game.commit.
const GAME_DRAFT := "game.draft"         # {rows:[{id, tiles:[...]}, ...]}

const PING := "ping"

# --- сервер -> клиент ---------------------------------------------------
const HELLO := "hello"
const AUTH_OK := "auth.ok"
const AUTH_ERR := "auth.err"
const SERVERS_LIST_S2C := "servers.list"
const ROOMS_LIST_S2C := "rooms.list"
const ROOM_STATE := "room.state"
const ROOM_LEFT := "room.left"
const QUICK_STATE := "quick.state"
const GAME_STATE := "game.state"
const GAME_ERROR := "game.error"
# Превью хода соперника: {from, tile, kind, row?, index?, at?} — без rid,
# рассылка. Отправителю не приходит (он и так знает, что перебирает).
const GAME_PEEK_S2C := "game.peek"
# Черновик стола соперника: {from, rows} — без rid, рассылка. Рисуется
# вместо базового стола, пока автор не завершит ход (game.state гасит).
const GAME_DRAFT_S2C := "game.draft"
const TOAST := "toast"
const PONG := "pong"

# Поле-коррелятор: клиент кладёт метку в запрос и по ней узнаёт СВОЙ ответ.
# Рассылки (чужие ходы) приходят без метки, и применять их надо вслепую.
#
# Имя не RID: RID — встроенный тип Godot, и константа с таким именем
# внутри класса конфликтует с ним.
const RID_FIELD := "rid"

const MAX_OPS_PER_COMMIT := 64

## Приводит разобранное сообщение сервера к виду, в котором его можно
## читать словарём, и возвращает его же.
##
## Зачем это вообще нужно. JSON умеет null, и сервер им пользуется: в
## auth.ok поле notice бывает null («уведомления нет»), и null приезжает
## в клиент обычным Nil. А Dictionary.get(ключ, умолчание) при КЛЮЧЕ,
## лежащем со значением null, возвращает null, а НЕ умолчание — то есть
## страховка `msg.get("reason", "причина по умолчанию")` не спасает.
## Дальше String(null) — это ошибка времени выполнения, а не пустая
## строка, и клиент падает на ровном месте: так ронялся вход по
## сохранённой сессии, то есть ВХОД В ИГРУ У ВСЕХ, кто заходил раньше.
##
## Чинить это в семидесяти местах по одному — значит завтра забыть
## семьдесят первое. Поэтому null вычищается ОДИН раз, на входе, и
## дальше все `.get(к, умолчание)` работают ровно так, как их читает
## человек: ключа нет — вернулось умолчание.
##
## Ключи с null убираются целиком, а не заменяются на пустую строку:
## иначе msg.get("notice", "") вернул бы «» в обоих случаях, и отличить
## «сервер не прислал» от «сервер прислал пустое» было бы нельзя.
##
## В массивах null превращается в пустую строку, а не выбрасывается:
## выбрасывание сдвинуло бы индексы и порушило бы всё, что читает
## элементы по номеру.
static func clean(value: Variant) -> Variant:
	match typeof(value):
		TYPE_DICTIONARY:
			var src: Dictionary = value
			var out := {}
			for key in src:
				if src[key] == null:
					continue
				out[key] = clean(src[key])
			return out
		TYPE_ARRAY:
			var arr: Array = value
			var out_arr := []
			for item in arr:
				out_arr.append("" if item == null else clean(item))
			return out_arr
	return value


## Разбирает и сразу вычищает. Единственная точка, где клиент
## превращает байты сервера в данные.
static func parse(text: String) -> Variant:
	var parsed = JSON.parse_string(text)
	return parsed if parsed == null else clean(parsed)

## Сообщение, на которое клиент обычно ждёт ответа на команду.
static func ok_types(command: String) -> PackedStringArray:
	match command:
		GAME_COMMIT, GAME_DRAW, GAME_SKIP, GAME_REJOIN, ROOM_START:
			return PackedStringArray([GAME_STATE, GAME_ERROR])
		# Превью и черновик — fire-and-forget: ответа нет, личных сообщений
		# не ждём.
		GAME_PEEK, GAME_DRAFT:
			return PackedStringArray()
		ROOM_CREATE:
			return PackedStringArray([ROOM_STATE, GAME_ERROR])
		# ROOM_JOIN в идущую партию отвечает сразу game.state.
		ROOM_JOIN:
			return PackedStringArray([ROOM_STATE, GAME_STATE, GAME_ERROR])
		ROOM_LEAVE, ROOM_DROP:
			return PackedStringArray([ROOM_LEFT, GAME_ERROR])
		QUICK_JOIN, QUICK_LEAVE:
			return PackedStringArray([QUICK_STATE, GAME_ERROR])
		ROOMS_LIST:
			return PackedStringArray([ROOMS_LIST_S2C, GAME_ERROR])
		SERVERS_LIST:
			return PackedStringArray([SERVERS_LIST_S2C, GAME_ERROR])
		REGISTER, LOGIN, RESUME, LOBBY_OPEN, YA_LOGIN:
			return PackedStringArray([AUTH_OK, AUTH_ERR])
	return PackedStringArray([GAME_ERROR])
