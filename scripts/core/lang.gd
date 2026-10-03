class_name Lang
extends RefCounted

# Центральная локализация: русский — язык исходников, английский —
# словарь ниже. Ключом служит сама русская строка, поэтому в русской
# локали t() возвращает вход как есть (все старые тесты зелёные), а в
# английской — перевод. Сообщения сервера тоже идут через t() в точке
# показа (toast), так что протокол и сервер не менялись: что не нашлось
# в словаре, показывается как пришло.
#
# Правила обёртки: заворачивать ВСЕ строковые литералы с кириллицей,
# кроме двух сравнений с ответом сервера в online_lobby (569/584): там
# сравнивается значение с провода (сервер всегда шлёт русский), и
# перевод сломал бы равенство в английской локали.

const LANG_RU := "ru"
const LANG_EN := "en"

const _EN := {
"  (нет связи)": "  (offline)",
" (бот)": " (bot)",
" · бот": " · bot",
" · боты %d": " · bots %d",
" · вы": " · you",
" · идёт": " · playing",
" · нет связи": " · offline",
" · пароль": " · password",
" · подключение…": " · connecting…",
" · ходит": " · to move",
"%s онлайн": "%s online",
"%s — %d с": "%s — %d s",
"%s · свободно %d из %d · первый ход: %s": "%s · %d of %d free · first turn: %s",
"106 чисел: 4 цвета (красный, синий, чёрный, оранжевый), значения 1–13,":
	"106 tiles: 4 colors (red, blue, black, orange), values 1–13,",
"[b]Колода пуста[/b]": "[b]Deck empty[/b]",
"[b]Колода[/b]": "[b]Deck[/b]",
"[b]Первый ход[/b]": "[b]First turn[/b]",
"[b]Ряды[/b]": "[b]Rows[/b]",
"[b]Ход[/b]": "[b]Turn[/b]",
"[b]Цель[/b]": "[b]Goal[/b]",
"«Отменить ход» возвращает стол и руку к началу текущего хода.":
	"\"Undo turn\" restores the table and hand to the start of the current turn.",
"Аккаунт создан": "Account created",
"Анимация бота": "Bot animation",
"Большой": "Big",
"Бот": "Bot",
"Брать неоткуда — остаётся только выкладка. Если выложить нечем — ход пропускается.":
	"Nothing to draw — only placing left. If you can't place, the turn is skipped.",
"Быстрая игра": "Quick play",
"В меню": "To menu",
"В течение хода стол можно свободно перестраивать, а кнопка":
	"During a turn you can freely rearrange the table, and the",
"В этот ход ещё ничего не менялось": "Nothing changed this turn yet",
"Ваш ход": "Your turn",
"Вернитесь в неё или покиньте насовсем.": "Go back or leave for good.",
"Вернуть": "Restore",
"Вернуться в комнату": "Back to room",
"Вернуться в партию": "Back to game",
"Вернуться к чекпоинту": "Restore checkpoint",
"Вернуться": "Back",
"Взять карту": "Draw a tile",
"Взять число из колоды?\nХод сразу завершится.":
	"Draw a tile from the deck?\nThe turn ends immediately.",
"Взять": "Draw",
"Возврат к чекпоинту": "Restored checkpoint",
"Возвращаемся": "Returning",
"Войти по коду": "Join by code",
"Войти": "Sign in",
"Воспользуйтесь кнопкой «Продолжить»": "Use the \"Continue\" button",
"Все комнаты": "All rooms",
"Все на месте. %s": "Everyone's here. %s",
"Всем остальным игрокам выкладываться можно с любого числа очков.":
	"Everyone else can start melding with any points.",
"Вход выполнен": "Signed in",
"Вход": "Sign in",
"Входим…": "Signing in…",
"Вы всё ещё в комнате %s: %s. ": "You're still in room %s: %s. ",
"Вы всё ещё в комнате %s: %s.": "You're still in room %s: %s.",
"Вы вышли": "Signed out",
"Вы не в комнате": "You're not in a room",
"Вы не в этой партии": "You're not in this game",
"Выложите хотя бы одно число или возьмите из колоды":
	"Place at least one tile or draw from the deck",
"Выйти в главное меню?": "Quit to main menu?",
"Выйти": "Quit",
"Выход в меню": "Quit to menu",
"Выход": "Quit",
"Готов(-а)": "Ready",
"Действия": "Actions",
"Джокер заменяет любое число любого цвета.": "A joker replaces any tile of any color.",
"Джокер — заменяет любое число любого цвета": "Joker — replaces any tile of any color",
"Для начала нужны двое живых игроков — остальные места займут боты.":
	"Need at least two humans to start — bots will fill the rest.",
"Если аккаунта нет": "No account yet",
"Ждём второго игрока": "Waiting for the second player",
"Ждём второго игрока: партия на паузе.": "Waiting for the second player: game paused.",
"Ждём игроков (%d из %d)": "Waiting for players (%d of %d)",
"Ждём остальных игроков (%d из %d).": "Waiting for players (%d of %d).",
"Ждём, начнёт хост.": "Waiting for the host to start.",
"Ждём…": "Waiting…",
"Закрыть": "Close",
"Заново": "Again",
"Заполните логин и пароль": "Enter login and password",
"Заполните логин, пароль и имя": "Enter login, password and name",
"Заходим в %s…": "Joining %s…",
"ИГРА ПО СЕТИ": "PLAY ONLINE",
"ИЛИ взять одно случайное число из колоды.": "OR draw one random tile from the deck.",
"Игра на паузе": "Game paused",
"Игра на паузе: кто-то отвалился. Ждём возвращения.":
	"Game paused: someone dropped. Waiting for them.",
"Игра начинается - первый ход:": "Game starts - first turn:",
"Игра окончена": "Game over",
"Играть по сети": "Play online",
"Игрок %d": "Player %d",
"Игроков:": "Players:",
"Имена игроков:": "Player names:",
"Ищем комнату": "Looking for a room",
"Каждый ход — ровно одно действие: выложить хотя бы одно число из руки":
	"Each turn is exactly one action: place at least one tile from your hand",
"Как играть": "How to play",
"Карточки:": "Tiles:",
"Колода ещё полна — возьмите число": "Deck is still full — draw a tile",
"Колода пуста": "Deck is empty",
"Колода\n%d": "Deck\n%d",
"Комнат найдено: %d": "Rooms found: %d",
"Комната %s закрылась, пока вы были офлайн": "Room %s closed while you were offline",
"Комната %s": "Room %s",
"Комната на сервере %s": "Room on server %s",
"Комната не найдена": "Room not found",
"Комнаты больше нет": "Room is gone",
"Крошечный": "Tiny",
"Крупный": "Large",
"Латвия": "Latvia",
"Лёгкий": "Easy",
"Максимум": "Max",
"Маленький": "Small",
"Меню": "Menu",
"Место %d:  %s": "Seat %d:  %s",
"Мусор в ходе": "Garbage in turn",
"На поле можно временно разбивать ряды (в том числе на 1 число),":
	"You may temporarily split rows (even down to 1 tile),",
"Набор: 3 или 4 числа одного значения разных цветов (например 7 красная, 7 синяя, 7 чёрная).":
	"Set: 3 or 4 tiles of one value in different colors (e.g. red 7, blue 7, black 7).",
"Назад": "Back",
"Настр.": "Settings",
"Настройки": "Settings",
"Начать партию": "Start game",
"Начать": "Start",
"Начинаем…": "Starting…",
"Начинает хост комнаты": "Room host starts",
"Начинайте.": "You start.",
"Не удалось войти в комнату": "Couldn't join the room",
"Не удалось войти": "Couldn't sign in",
"Не удалось начать партию": "Couldn't start the game",
"Не удалось подключиться к %s": "Couldn't connect to %s",
"Не удалось покинуть комнату": "Couldn't leave the room",
"Не удалось создать код комнаты": "Couldn't create room code",
"Не удалось создать комнату": "Couldn't create the room",
"Невозможный": "Impossible",
"Нельзя брать из колоды после выкладки": "Can't draw from the deck after placing",
"Некорректное сообщение": "Malformed message",
"Нет связи ни с одним сервером (%s).": "No server reachable (%s).",
"Нет связи с сервером": "No server connection",
"Нет связи с сервером: %s": "No connection to server: %s",
"Нет связи с сервером: вернуться в партию пока нельзя":
	"No server connection: can't return to the game yet",
"Нет связи: %s": "Offline: %s",
"Нет сохранённых раскладов": "No saved layouts",
"Нужно минимум 2 игрока": "Need at least 2 players",
"Обновить": "Refresh",
"Отмена": "Cancel",
"Отменить ход": "Undo turn",
"Отправляем ход…": "Sending move…",
"Партия не идёт": "No game running",
"Партия не найдена": "Game not found",
"Партия уже идёт": "Game already in progress",
"Партия уже началась": "Game already started",
"Первый игрок, оставшийся без чисел в руке, побеждает.":
	"The first player left with no tiles in hand wins.",
"Первый ход: от 30": "First turn: 30+",
"Передайте устройство игроку": "Pass the device to the player",
"Перестраивать можно любые ряды на столе, включая выложенные другими игроками:":
	"You can rearrange any rows on the table, including opponents':",
"Перетащите сюда число - новый ряд": "Drag a tile here - new row",
"По сети": "Online",
"Побед: %d": "Wins: %d",
"Побед:": "Wins:",
"Победитель - %s": "Winner - %s",
"Подключаемся к %s…": "Connecting to %s…",
"Подск.": "Hint",
"Подсказка - показать возможный ход": "Hint – show a possible move",
"Подсказка": "Hint",
"Подсказка: возьмите число из колоды": "Hint: draw a tile from the deck",
"Подсказка: выложите %d %s — это +%d очков": "Hint: place %d %s — that's +%d points",
"Подсказка: закончите перестановку на столе": "Hint: finish rearranging the table",
"Подсказка: можно завершать ход": "Hint: you can finish the turn",
"Подсказка: пропустите ход": "Hint: skip the turn",
"Пока никто не создал комнату. Создайте свою.": "No rooms yet. Create your own.",
"Показаны комнаты без %s. Остальные серверы не ответили.":
	"Showing rooms without %s. Other servers didn't respond.",
"Покидаем комнату…": "Leaving room…",
"Покинуть": "Leave",
"Помощь": "Help",
"Поражений: %d": "Losses: %d",
"Поражений:": "Losses:",
"Правила игры": "How to play",
"Продолжить": "Continue",
"Пропуск хода": "Skip turn",
"Пропуск": "Skip",
"Пустой ход": "Empty move",
"Размер текста и карточек": "Text and tile size",
"Расклад сохранён (чекпоинт)": "Layout saved (checkpoint)",
"Регистрация": "Sign up",
"Россия": "Russia",
"Самый первый ход игры (первый игрок) должен быть не меньше 30 очков (сумма чисел),":
	"The very first turn of the game (first player) must be at least 30 points (tile total),",
"Самый первый ход игры — минимум %d очков (у вас %d)":
	"The very first turn needs at least %d points (you have %d)",
"Своя комната": "Private room",
"Сейчас не ваш ход": "It's not your turn",
"Сервер %s больше не в списке": "Server %s is no longer listed",
"Сервер не ответил вовремя": "Server timed out",
"Сервер: %s": "Server: %s",
"Серверов в сети: %d из %d": "Servers online: %d of %d",
"Серия: 3 и более числа одного цвета по порядку (например 5, 6, 7).":
	"Run: 3 or more tiles of one color in order (e.g. 5, 6, 7).",
"Сессия не восстановилась на %s": "Session not restored on %s",
"Сессия недействительна": "Session invalid",
"Слишком много операций за ход": "Too many ops in one turn",
"Слишком много попыток. Подождите минуту.": "Too many attempts. Wait a minute.",
"Сложность ботов:": "Bot difficulty:",
"Сложный": "Hard",
"Сначала войдите": "Sign in first",
"Сначала закончите перестановку на столе": "Finish rearranging the table first",
"Сначала покиньте текущую партию: room.leave или room.drop":
	"Leave the current game first: room.leave or room.drop",
"Сначала что-нибудь измените на столе": "Change something on the table first",
"Собираем список комнат…": "Loading room list…",
"Создать комнату": "Create room",
"Создать": "Create",
"Создаём аккаунт…": "Creating account…",
"Создаём комнату на %s…": "Creating room on %s…",
"Создаём комнату": "Creating room",
"Соединение только для чтения": "Read-only connection",
"Соперник не отвечает. Осталось ждать %d с.": "Opponent not responding. %d s left.",
"Сохр.": "Save",
"Сохранить расклад (чекпоинт)": "Save layout (checkpoint)",
"Сохранить": "Save",
"Список серверов пуст — игра собрана неправильно.": "Server list is empty — bad build.",
"Средний": "Medium",
"Старый пароль неверен": "Old password is wrong",
"Статистика": "Stats",
"Стол в невалидном состоянии": "Table is invalid",
"Стол и рука возвращены к началу хода": "Table and hand restored to turn start",
"Стр. %d из %d": "Page %d of %d",
"Сыграно партий: %d": "Games played: %d",
"Сыграно партий:": "Games played:",
"Текст:": "Text:",
"Ход нельзя завершить": "Turn cannot be finished",
"Ход отклонён": "Move rejected",
"Ход отклонён: нельзя переместить эти числа (проверьте, что они ещё на столе)":
	"Move rejected: can't move these tiles (check they're still on the table)",
"Ход соперника": "Opponent's turn",
"Ход: %s": "Turn: %s",
"в наборе не может быть двух чисел одного цвета": "a set can't have two tiles of the same color",
"в ряду должно быть минимум 3 числа": "a row must have at least 3 tiles",
"в серии не хватает числа %d (стоит %d)": "run is missing tile %d (has %d)",
"вход выполнен в другом окне": "signed in in another window",
"вход не удался": "sign-in failed",
"если правило включено в настройках.": "if the rule is enabled in settings.",
"жёлтый": "yellow",
"игроки в сборе": "everyone's here",
"имя в игре": "in-game name",
"код": "code",
"красный": "red",
"кроме вас никого нет": "you're all alone",
"логин": "login",
"любой": "any",
"мест: %d": "seats: %d",
"на %s ожидали %s, пришло %s": "on %s expected %s, got %s",
"набор не может быть длиннее 4 чисел (уникальные цвета)":
	"a set can't be longer than 4 tiles (unique colors)",
"название (необязательно)": "name (optional)",
"не ответил": "no answer",
"не проверен": "unverified",
"не серия одного цвета по порядку и не набор одного значения разных цветов":
	"neither a same-color run in order nor a same-value set of different colors",
"не удалось записать %s: %s": "couldn't write %s: %s",
"не удалось записать сессию: %s": "couldn't write session: %s",
"не удалось начать подключение к %s": "couldn't start connecting to %s",
"не удалось начать подключение": "couldn't start connecting",
"не удалось отправить команду": "couldn't send command",
"не удалось сохранить %s: %s": "couldn't save %s: %s",
"не удалось сохранить сессию: %s": "couldn't save session: %s",
"нет связи с сервером": "no server connection",
"нет связи": "offline",
"нет соединения": "no connection",
"но к концу хода каждый ряд обязан содержать минимум 3 числа и быть валидным.":
	"but by the end of the turn every row must hold at least 3 tiles and be valid.",
"оранжевый": "orange",
"от 30": "30+",
"отказал сервер (код %d)": "server refused (code %d)",
"ошибка": "error",
"пароль (необязательно)": "password (optional)",
"пароль": "password",
"партия идёт": "game in progress",
"партия недоступна": "game unavailable",
"по 2 экземпляра каждого + 2 джокера (жёлтый и фиолетовый).":
	"2 copies of each + 2 jokers (yellow and purple).",
"подключение к %s…": "connecting to %s…",
"разбивать их, переносить числа между рядами и возвращать в руку.":
	"split them, move tiles between rows and take them back to hand.",
"связь потеряна (%s), переподключаемся…": "connection lost (%s), reconnecting…",
"связь прервалась": "connection dropped",
"связь с сервером прервана": "server connection lost",
"сервер закрыл соединение (код %d)": "server closed the connection (code %d)",
"сервер не ответил вовремя": "server timed out",
"сервер прислал фишку №%d, которой нет в каталоге (%d шт.known)":
	"server sent tile #%d missing from catalog (%d known)",
"серия выходит за пределы чисел 1..13": "run goes beyond tiles 1..13",
"серия должна быть одного цвета": "a run must be a single color",
"серия не может быть длиннее 13 чисел": "a run can't be longer than 13 tiles",
"сертификат сервера %s не найден в %s — связь с ним будет отвергнута":
	"server certificate %s not found in %s — connection will be refused",
"сессия больше недействительна": "session expired",
"синий": "blue",
"соединение не установлено": "connection not established",
"соединение оборвано": "connection dropped",
"фиолетовый": "purple",
"числа · 4 цвета · джокеры": "tiles · 4 colors · jokers",
"числа идут не по порядку: после %d нужно %d": "tiles out of order: after %d comes %d",
"чёрный": "black",
"— свободно —": "— free —",
"В комнате нет свободных мест": "Room is full",
"Введите логин": "Enter login",
"Введите ник": "Enter nickname",
"Время хода вышло — фишка взята из колоды": "Turn time out — drew from the deck",
"Время хода вышло — ваш стол принят как ход": "Turn time out — your table accepted as the move",
"Время хода вышло — ход пропущен автоматически": "Turn time out — turn skipped automatically",
"Внутренняя ошибка сервера": "Server internal error",
"Логин: 3–20 символов, латиница, цифры, _ . -": "Login: 3-20 chars, latin, digits, _ . -",
"На сервере слишком много комнат, попробуйте другой": "Server has too many rooms, try another",
"Неверный логин или пароль": "Wrong login or password",
"Неверный пароль комнаты": "Wrong room password",
"Ник: ботом может называться только бот": "Nickname: only bots can be called bot",
"Ник: без управляющих символов": "Nickname: no control characters",
"Ник: максимум 24 символа": "Nickname: at most 24 characters",
"Ник: это служебное имя": "Nickname: reserved name",
"Пароль: максимум 200 символов": "Password: at most 200 characters",
"Пароль: минимум 6 символов": "Password: at least 6 characters",
"Этот логин уже занят": "Login already taken",
"Язык:": "Language:",
}
static var lang := "ru"
## Последний установленный заголовок окна (для тестов: у
## DisplayServer нет геттера названия в скриптах).
static var last_title := ""



static func is_en() -> bool:
	return lang == LANG_EN

static func set_lang(code: String) -> void:
	lang = LANG_EN if code == LANG_EN else LANG_RU
	apply_title()

## Название игры: Антисклероз / Anti-Sclerosis.
static func app_name() -> String:
	return "Anti-Sclerosis" if is_en() else "Антисклероз"

static func apply_title() -> void:
	last_title = app_name()
	DisplayServer.window_set_title(last_title)

static func has_key(s: String) -> bool:
	return _EN.has(s)

static func all_keys() -> Array:
	return _EN.keys()

static func t(s: String) -> String:
	if s.is_empty() or not is_en():
		return s
	if _EN.has(s):
		return String(_EN[s])
	if s.begins_with("Неизвестная команда "):
		return "Unknown command " + s.substr("Неизвестная команда ".length())
	return s

## Переводит каждый элемент массива (для константных списков имён
## Settings: в const вызовы запрещены, поэтому перевод на месте use).
static func names(arr: Array) -> PackedStringArray:
	var out := PackedStringArray()
	for n in arr:
		out.append(t(String(n)))
	return out

## Слово «карточка» во множественном числе: в русском три формы,
## в английском две.
static func card_word(count: int) -> String:
	if is_en():
		return "tile" if count == 1 else "tiles"
	var d := count % 10
	var h := count % 100
	if d == 1 and h != 11:
		return "карточку"
	if d >= 2 and d <= 4 and not (h >= 12 and h <= 14):
		return "карточки"
	return "карточек"


