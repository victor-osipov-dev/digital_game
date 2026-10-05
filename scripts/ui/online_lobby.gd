class_name OnlineLobby
extends Control
const Lang := preload("res://scripts/core/lang.gd")

# Сетевое меню: вход, список комнат со всех серверов, ожидание игроков.
#
# Отдельный экран, а не ещё одна кнопка в главном меню, потому что здесь
# есть состояния, которых в главном нет: сервер может быть недоступен,
# сессия может протухнуть, комната может ждать второго игрока минуту.
# Всё это нужно показывать, а не сообщать тостом поверх пустоты.
#
# Кто где настоящий: сервер держит партию, здесь мы только спрашиваем
# «что там» и отправляем «хочу».
# preload, а не class_name: глобальный список классов читается из кэша
# редактора и на новом файле отстаёт.
const UiThemeClass := preload("res://scripts/ui/ui_theme.gd")

# Комнат на странице списка: строкам с названиями нужно место, а
# страница не резиновая — остальное листается пагинацией.
const ROOMS_PAGE_SIZE := 5

## Мост SDK Яндекс Игр (только Web). Один load на файл.
const YA_SDK_PATH := "res://scripts/platform/yandex_sdk.gd"

var _overlay: ColorRect = null
var _page_auth: VBoxContainer = null
var _page_rooms: VBoxContainer = null
var _page_lobby: VBoxContainer = null

var _status: Label = null
var _busy: Label = null
# Заголовок окна лобби. Отдельное поле не для красоты: на телефоне в
# узком портрете он не помещался рядом с «Назад» и обрезался, поэтому
# размер шрифта у него подбирается под реально свободную ширину.
var _title: Label = null
# Корень прокручиваемой разметки: его шириной меряем «сколько реально
# осталось», и по ней же решаем, складывать ли ряды в столбик.
var _root: VBoxContainer = null
# Ряд «заголовок + Назад»: по его фактической ширине считается, сколько
# места достанется заголовку.
var _head: HBoxContainer = null
# Ряды, которые на узком экране встают друг под другом: по горизонтали
# два-три поля делят ширину и сжимаются в нечитаемые полоски. Список
# наполняется при сборке страниц и обходится в _relayout.
var _stack_rows: Array = []
var _avail_w := 0.0
var _last_scale := -1

var _login_edit: LineEdit = null
var _pass_edit: LineEdit = null
var _nick_edit: LineEdit = null
var _auth_note: Label = null
var _login_btn: Button = null
var _register_btn: Button = null
## Контролы парольного входа (прячем на Web: авторизация только Yandex ID).
var _auth_form: Array = []
## Блок входа через Яндекс (только Web).
var _auth_ya_box: VBoxContainer = null
var _ya_btn: Button = null
var _ya_busy := false
## Модалка пользы перед входом через Яндекс (только Web): объясняет,
## зачем входить, и даёт честный выход гостем. Строится лениво.
var _ya_modal: ColorRect = null
var _ya_panel: PanelContainer = null
## Таблица лидеров модалкой (не страницей): серверный проверенный топ
## + (Web) Яндекс. Строится лениво.
var _board_modal: ColorRect = null
var _board_panel: PanelContainer = null
var _board_grid: GridContainer = null
var _board_me: Label = null
var _board_note: Label = null
var _ya_board_wrap: VBoxContainer = null
var _ya_board_grid: GridContainer = null
var _ya_board_note: Label = null
## Подтверждение удаления аккаунта (только Android): строится лениво,
## служит и окном «удалено» (без кнопки отмены).
var _del_modal: ColorRect = null
var _del_title: Label = null
var _del_text: Label = null
var _del_ok: Button = null
var _del_cancel: Button = null
var _del_action: Callable = Callable()

var _server_label: Label = null
var _server_box: VBoxContainer = null
var _rooms_box: VBoxContainer = null
var _rooms_note: Label = null
var _refresh_btn: Button = null

var _seats_option: OptionButton = null
var _create_row: BoxContainer = null
var _room_name: LineEdit = null
var _room_pass: LineEdit = null
var _require_30: CheckBox = null
var _create_btn: Button = null
var _play_btn: Button = null
var _board_btn: Button = null
var _tabs_row: BoxContainer = null
var _tab_group: ButtonGroup = null
var _tab_create_btn: Button = null
var _tab_code_btn: Button = null
var _create_box: VBoxContainer = null
var _code_box: VBoxContainer = null
var _rooms_tab := ""
var _page_row: BoxContainer = null
var _page_prev: Button = null
var _page_next: Button = null
var _page_label: Label = null
var _rooms_page := 0
var _join_code: LineEdit = null
var _join_pass: LineEdit = null
var _join_btn: Button = null

var _lobby_code: Label = null
var _lobby_seats: Label = null
var _lobby_players: VBoxContainer = null
var _auto_hint: Label = null
var _start_btn: Button = null
var _leave_btn: Button = null
var _lobby_note: Label = null

var _rooms: Array = []
var _busy_flag := false
## Фоновое обновление списка уже летит: повторный тик таймера и кнопка
## «Обновить» новых запросов не плодят — тихо пропускают.
var _rooms_loading := false
## Закрытие модалки таблицы: живое и во время запроса (закрытие состояние
## не меняет — в отличие от кнопок, которые его меняют).
var _board_close_btn: Button = null
var _started := false
var _tick: Timer = null
var _rooms_timer: Timer = null
var _back_btn: Button = null
var _stuck_box: PanelContainer = null
var _stuck_label: Label = null
var _stuck_row: BoxContainer = null

# Комната, в которой мы сейчас сидим (страница лобби). Нужна, чтобы при
# выходе из лобби в главное меню не потерять её: кнопки «вернуться» и
# «покинуть насовсем» должны остаться доступными и там, и в списке комнат.
var _current_room: Dictionary = {}
# Код текущей комнаты отдельным полем: _current_room чистится, когда мы
# уходим парковать комнату в главное меню, а код ещё понадобится, если
# партия начнётся без нас — восстановить pending как «партия идёт».
var _lobby_room_code := ""
var _return_btn: Button = null
var _drop_btn: Button = null
# Все ли места заняты — по последнему снимку лобби. Кнопка «Начать»
# опирается на это, а не пересчитывает сама: пересчёт в двух местах
# разойдётся, и хост увидит доступную кнопку, которую сервер не примет.
var _lobby_all_in := false
# Достаточно ли ЖИВЫХ ЛЮДЕЙ, чтобы партия могла начаться: двое и больше.
# Боты доберутся сами как при заполнении, так и по таймеру автостарта,
# поэтому кнопке «Начать» не нужна полная комната — нужны двое.
var _lobby_ready := false

# Как часто освежать «кто на связи», пока меню открыто. Реже, чем список
# комнат: список — по кнопке, а вот «сервер жив» должно исправляться само,
# иначе меню минутами обещает связь с машиной, которая давно упала.
const HEALTH_TICK_S := 20.0


# =============================================================== жизненный цикл

func _ready() -> void:
	# Интерфейс строится сразу, а не при первом открытии: иначе первое
	# нажатие «Играть по сети» ждало бы сборку разметки, и кнопка выглядела
	# бы зависшей. При этом сам экран остаётся скрытым и не перехватывает
	# щелчки главного меню.
	_build()
	# Ориентацию экрана на телефоне крутят, и размер окна меняется на
	# ходу: без этого подписки раз вёрстка остаётся рассчитанной под
	# стартовый портрет — заголовок обрезан, поля в ряд не влезают.
	resized.connect(_relayout)
	get_viewport().size_changed.connect(_relayout)
	_relayout()


## Смена сцены с проверкой, что нас ещё есть в дереве.
##
## Каждый вызовок сюда достигается после await — ответа сервера,
## таймера или кадра. За это время сцену уже могли сменить: игрок
## вышел в меню, связь отвалилась и нас выкинуло, окно закрылось. У
## отсоединённого узла get_tree() возвращает null, и прямой вызов
## change_scene_to_file на нём падал с «Cannot call method
## 'change_scene_to_file' on a null value». Менять сцену тут уже
## нечем и незачем — тихо уходим.
func _go_scene(path: String) -> bool:
	if not is_inside_tree():
		return false
	get_tree().change_scene_to_file(path)
	return true


func open() -> void:
	_build()
	visible = true
	_tick.start()
	_rooms_timer.start()
	_refresh_presence()
	_enter()

func close() -> void:
	# Уже начатую партию бросать нельзя: место в комнате держится, и её
	# нужно покинуть явно, иначе сервер будет ждать нас до конца партии.
	if _started:
		_started = false
		Net.leave_room()
		_current_room = {}
	# Выходим из лобби комнаты в главное меню, саму комнату не покидая:
	# место за нами сохраняется, и «вернуться»/«покинуть насовсем» должны
	# ждать игрока и на главном экране, и в списке комнат.
	elif not _current_room.is_empty():
		Net.park_room(_current_room)
		_current_room = {}
	visible = false
	_tick.stop()
	_rooms_timer.stop()


func _on_net_connection(connected: bool, detail: String) -> void:
	_update_status()
	if not visible:
		return
	if connected:
		# Связь восстановлена: прежнее «нет связи» должно уйти, иначе
		# красная надпись переживёт удачный переподключительный сеанс.
		# Занятую надпись трогать нельзя — она про другой запрос.
		if not _busy_flag:
			_set_note(_busy, "", false)
		# Приветствие к этой точке уже пришло, если состояние живое, —
		# пересчитываем кнопки, чтобы не оставить их серыми: они считаются
		# один раз в _build, и между открытием сокета и hello флажок
		# is_greeted() ещё ложный.
		_update_buttons()
		# Вход через reconnect уже случился и pending сверен с сервером
		# (auth.ok.room). Если сервер больше не числит нас в комнате, а лобби
		# всё ещё показывает комнату с прошлой жизни — комната закрылась,
		# пока мы были офлайн, и держать её на экране нельзя: выход оттуда
		# припарковал бы мёртвую комнату и повесил баннер «вы всё ещё в
		# комнате», в которую не вернуться.
		if not _current_room.is_empty():
			_reconcile_room_after_reconnect()
		return
	# connected == false значит не «связь оборвалась», а «связи пока
	# нет»: так же помечает рукопожатие, когда сокет уже создан, но
	# ещё не открыт. Красное «Нет связи» рядом с живым пингом того же
	# сервера в списке выглядело как противоречие, поэтому обрывом
	# считаем только настоящий OFFLINE, а is_online() — ровно та
	# проверка, которая эти состояния различает (её же _on_tick
	# использует, чтобы не пересоздавать сокет на ровном месте).
	if Net.is_online():
		return
	_set_note(_busy, Lang.t("Нет связи с сервером: %s") % detail, true)


func _on_net_greeted(_hello: Dictionary) -> void:
	# Кнопки входа считаются в _build, когда is_greeted() ещё false, и
	# ждут именно этого сигнала, чтобы стать кликабельными.
	_update_buttons()


func _on_net_room_state(room: Dictionary) -> void:
	_show_lobby(room)

func _on_net_room_left() -> void:
	_started = false
	_current_room = {}
	_lobby_room_code = ""
	if visible:
		_goto_rooms()

## Сличает комнату, которую показывает лобби, с серверной правдой после
## переподключения. pending уже заполнен из auth.ok.room: пустой — комната
## закрылась, пока нас не было (или владелец вышел), и место в ней больше
## не держится. Возвращаемся в список и говорим об этом прямо, а не вешаем
## баннер «вы всё ещё в комнате», в которую вернуться нельзя.
func _reconcile_room_after_reconnect() -> void:
	if not Net.pending_room().is_empty():
		# Сервер подтвердил, что место за нами держится: лобби не врёт.
		return
	var code := String(_current_room.get("code", "?"))
	_current_room = {}
	_lobby_room_code = ""
	if _page_lobby.visible:
		_goto_rooms()
		_set_note(_rooms_note, Lang.t("Комната %s закрылась, пока вы были офлайн") % code, true)

func _on_net_game_state(_view: Dictionary, _grace: float, _paused: bool, _waiting: bool) -> void:
	# Партия началась — уходим в неё, сами её не рисуем. Сидим на странице
	# комнат, а не в лобби комнаты? Тогда это не наша рассылка (мягко
	# вышедшего игрока сервер из партии выписал, состояния ему не шлют).
	if not _page_lobby.visible:
		# Партия началась, пока мы в отрыве от лобби (главное меню после
		# парковки комнаты). Рассылка GAME_STATE СБРАСЫВАЕТ pending, и без
		# восстановления пропала бы и кнопка «вернуться», и баннер в списке
		# комнат, хотя место в партии за нами ещё держится. Возвращаем
		# pending как «партия идёт» — вернуться в неё всё ещё можно.
		if not _lobby_room_code.is_empty():
			Net.park_room({"code": _lobby_room_code, "state": "playing"})
		return
	# Смена сцены уже заказана (room_state тоже уводит в партию) —
	# повторный вызов осиротил бы первый экземпляр сцены.
	if _started:
		return
	_started = true
	Net.plan_game(true)
	_go_scene("res://scenes/game.tscn")


func _enter() -> void:
	if not Net.is_linked():
		# Сервер выбираем при входе: партия живёт на одном сервере, и
		# менять сервер посреди неё нельзя.
		_do_connect()
		return
	if not Net.is_logged_in():
		_enter_auth()
		return
	_goto_rooms()


func _enter_auth() -> void:
	# На Web промежуточной страницы входа нет: сразу быстрый путь —
	# тихая проверка готового профиля, иначе модалка с пользой.
	if OS.has_feature("web"):
		_enter_web_fast()
		return
	_set_page(_page_auth)
	_update_status()
	_update_buttons()
	# Надпись о связи сюда не переносится: на странице входа она была бы
	# не к месту и залипала бы после успешного подключения, потому что
	# чистится только вместе с busy-задачей.
	_set_note(_busy, "", false)
	_set_auth_note("")
	if _login_edit.text.is_empty():
		_login_edit.text = Net.session_login()
	if _pass_edit.text.is_empty():
		_pass_edit.text = Net.session_password()
	if _nick_edit.text.is_empty():
		_nick_edit.text = Net.session_nick()
	_login_edit.grab_focus()
	_sync_auth_mode()


## На Web парольный вход скрыт (требование 1.2: авторизация только через
## Yandex ID) — вместо него кнопка Яндекса. Везде ещё — как было.
func _sync_auth_mode() -> void:
	if _auth_form.is_empty() and _auth_ya_box == null:
		return
	var web := OS.has_feature("web")
	for c in _auth_form:
		(c as Control).visible = not web
	if _auth_ya_box != null:
		_auth_ya_box.visible = web


## Подключается к серверу. Какой именно — неважно для входа: сессия
## общая для всего кластера, и вход на любом сервере открывает комнаты
## обоих. Но если в сети есть РАБОТАЮЩАЯ партия, подключаться надо
## ровно к тому серверу, который её держит, иначе партия потеряется.
func _do_connect() -> void:
	var sv: Servers = Net.servers
	var entry := sv.fastest_online()
	if entry.is_empty():
		# Ни один сервер не прошёл проверку. Всё равно пробуем первый:
		# проверка могла не успеть, а сервер вполне может быть живым.
		entry = sv.first()
	if entry.is_empty():
		_set_note(_busy, sv.offline_hint(), true)
		return
	_set_note(_busy, Lang.t("Подключаемся к %s…") % sv.label_of(entry), false)
	if not Net.connect_to(entry):
		return
	# Ждём не фиксированное время, а прихода приветствия: у скрипта нет
	# прямого сигнала «готов», а ждать наугад — значит иногда показывать
	# форму входа ещё до готовности сервера к входу.
	var deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline:
		if Net.is_logged_in():
			_goto_rooms()
			return
		if Net.is_greeted():
			# Сервер поздоровался, а сессии нет — нет смысла ждать
			# остаток таймаута, вход уже возможен.
			break
		if not Net.is_online() and Net.has_session():
			# Сокет упал, пока поднимался. Пробуем следующий сервер.
			break
		await get_tree().process_frame
	if Net.is_logged_in():
		_goto_rooms()
	elif visible:
		_enter_auth()
		_update_status()
		_update_buttons()


# =============================================================== вход

## Запоминает пароль по мере набора. Само значение уходит на диск из
## Net: там же, где лежит токен, — пароль не должен попасть в файл
## настроек, который игрок шлёт в поддержку.
func _on_pass_typed(text: String) -> void:
	Net.remember_password(text)


func _do_login() -> void:
	var login_name := _login_edit.text.strip_edges()
	var password := _pass_edit.text
	if login_name.is_empty() or password.is_empty():
		_set_auth_note(Lang.t("Заполните логин и пароль"), true)
		return
	_set_auth_note(Lang.t("Входим…"))
	var res := await Net.login(login_name, password)
	_after_auth(res, Lang.t("Вход выполнен"))


func _do_register() -> void:
	var login_name := _login_edit.text.strip_edges()
	var password := _pass_edit.text
	var nick := _nick_edit.text.strip_edges()
	if login_name.is_empty() or password.is_empty() or nick.is_empty():
		_set_auth_note(Lang.t("Заполните логин, пароль и имя"), true)
		return
	# Порог — как на сервере (accounts.js: минимум 6), иначе пароли
	# длиной 4–5 уходили в сеть и возвращались отказом оттуда.
	if password.length() < 6:
		_set_auth_note(Lang.t("Пароль: минимум 6 символов"), true)
		return
	_set_auth_note(Lang.t("Создаём аккаунт…"))
	var res := await Net.register(login_name, password, nick)
	_after_auth(res, Lang.t("Аккаунт создан"))


## Вход через Yandex ID (только Web): сначала пробуем готовый профиль
## (вдруг уже авторизован — тогда диалог не нужен и не показывается),
## иначе явный диалог с объяснением выгод. Без UID дальше нельзя:
## гость играет офлайн, онлайн закрыт.
func _do_ya_login() -> void:
	if _ya_busy:
		return
	_ya_busy = true
	_update_buttons()
	# ensure_sdk идемпотентен (сторожок __ysdkRequested): зовём и отсюда,
	# а не только из главного меню — иначе прямой заход в лобби ждал бы
	# SDK, который никто не попросил загрузить.
	_ysdk_call("ensure_sdk")
	_ya_log("click: ensure requested, sdk script present=%s" % str(_ysdk_script() != null))
	# SDK нет (игра открыта не из Яндекс Игр) — дальше всё равно ответит
	# отказом; объясняем сразу и честно, а не «без входа...» в конце.
	for i in range(20):
		var rs := _ysdk_poll("sdk")
		if i % 5 == 0:
			_ya_log("sdk wait tick %d: %s" % [i, str(rs)])
		if bool(rs.get("ready", false)) or not String(rs.get("error", "")).is_empty():
			break
		await get_tree().create_timer(0.5).timeout
		if not is_instance_valid(self) or not visible:
			_ya_busy = false
			_ya_log("lobby hidden/closed during sdk wait")
			return
	var final := _ysdk_poll("sdk")
	_ya_log("sdk poll after wait: %s" % str(final))
	if not bool(final.get("ready", false)):
		_ya_busy = false
		_update_buttons()
		_set_auth_note(Lang.t("Вход и реклама работают только внутри Яндекс Игр"), true)
		return
	_set_auth_note(Lang.t("Получаем профиль Яндекс…"))
	var profile := await _ya_profile()
	_ya_log("profile: uid_empty=%s authorized=%s" % [str(String(profile.get("uid", "")).is_empty()), str(bool(profile.get("authorized", false)))])
	if String(profile.get("uid", "")).is_empty() \
			or not bool(profile.get("authorized", false)):
		_set_auth_note(Lang.t("Открываем вход через Яндекс…"))
		_ysdk_call("open_auth_dialog")
		_ya_log("auth dialog opened, waiting")
		if await _ysdk_wait("auth", 600):
			_ya_log("auth dialog done, re-reading profile")
			profile = await _ya_profile()
		else:
			_ya_log("auth wait interrupted (lobby closed)")
			profile = {}
	if String(profile.get("uid", "")).is_empty():
		_ya_busy = false
		_update_buttons()
		_set_auth_note(Lang.t("Без входа доступен только офлайн-режим"), true)
		return
	var res := await Net.ya_login(String(profile.get("uid", "")),
		String(profile.get("name", "")))
	_ya_log("ya_login: ok=%s reason='%s'" % [str(res.get("ok", "?")), str(res.get("reason", ""))])
	_ya_busy = false
	_after_auth(res, Lang.t("Вход выполнен"))


## Профиль из SDK (пусто — не получилось). Повторный вызов после диалога.
func _ya_profile() -> Dictionary:
	_ysdk_call("request_player")
	_ya_log("request_player sent")
	if not await _ysdk_wait("player", 40):
		_ya_log("player wait TIMEOUT (20s)")
		return {}
	var st := _ysdk_poll("player")
	_ya_log("player poll: done=%s has_data=%s err='%s'" % [str(st.get("done", "?")), str(st.get("data", null) != null), str(st.get("error", ""))])
	var data = st.get("data", null)
	if data is Dictionary:
		return data
	return {}


## Диагностика входа через Яндекс: точки [ya-lobby] в консоли браузера
## (в Web print() уходит в console.log). Флаг — DEBUG_LOG моста; мост
## отсутствует (не Web) — печатаем всегда, иначе причину молчания,
## включая «мост не загрузился», не увидеть.
func _ya_log(msg: String) -> void:
	var sdk = _ysdk_script()
	if sdk == null:
		print("[ya-lobby] " + msg)
		return
	if bool((sdk as GDScript).DEBUG_LOG):
		print("[ya-lobby] " + msg)


## Web-вход без промежуточной страницы (требования Яндекс Игр):
## 1. Играть без регистрации можно: отказ («Без входа», мимо модалки)
##    закрывает лобби назад в меню; офлайн и локальное ничто не трогаем.
## 2. Только Yandex ID: парольная форма на Web скрыта (_sync_auth_mode),
##    диалог — только openAuthDialog из SDK, своего ничего нет.
## 3. Старт — лишь по явному нажатию «Играть с другими» (открытие лобби);
##    при запуске и в фоне авторизации нет (в _ready только ensure_sdk).
## 4. Перед диалогом — модалка с пользой и честным выбором.
## 5-6. Гость играет офлайн, прогресс на устройстве не пропадает:
##    отказ ничего не стирает, просто закрывает лобби.
## 7. Залогинен (сессия) или уже авторизован в Яндексе — входим молча:
##    сначала тихий профиль БЕЗ диалога, модалку не показываем.
func _enter_web_fast() -> void:
	# Страницы прячем все: фоном модалки должна быть пустая шапка лобби,
	# а не старая страница входа (иначе обе видны одновременно).
	_hide_all_pages()
	_update_status()
	_update_buttons()
	_set_auth_note("")
	_ysdk_call("ensure_sdk")
	if not await _sdk_ready_short():
		_ya_log("sdk not ready, showing benefit")
		_show_ya_benefit()
		return
	_ysdk_call("request_player")
	if not await _ysdk_wait("player", 20):
		_ya_log("silent profile timeout, showing benefit")
		_show_ya_benefit()
		return
	var data = _ysdk_poll("player").get("data", null)
	if data is Dictionary and not String(data.get("uid", "")).is_empty() \
			and bool(data.get("authorized", false)):
		_ya_log("already authorized in Yandex, silent login")
		_do_ya_login()
		return
	_show_ya_benefit()


## Короткое ожидание готовности SDK (до ~5 с). Дольше висеть нельзя:
## при провале показываем модалку с выбором, а не крутим вечно.
func _sdk_ready_short() -> bool:
	for i in range(10):
		var rs := _ysdk_poll("sdk")
		if bool(rs.get("ready", false)) or not String(rs.get("error", "")).is_empty():
			return bool(rs.get("ready", false))
		await get_tree().create_timer(0.5).timeout
		if not is_instance_valid(self) or not visible:
			return false
	return bool(_ysdk_poll("sdk").get("ready", false))


## Модалка пользы: зачем входить + честный выход гостем. Строится один
## раз, дальше только показывается. Своя, лоббийная: модалка game.gd
## живёт в сцене игры и из меню недоступна (тот же тёмный стиль).
func _build_ya_benefit() -> void:
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.6)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	dim.visible = false
	dim.gui_input.connect(_on_ya_benefit_backdrop)
	add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.add_child(center)
	var panel := PanelContainer.new()
	var psb := StyleBoxFlat.new()
	psb.bg_color = Color(0.13, 0.13, 0.16, 0.98)
	psb.set_corner_radius_all(10)
	psb.content_margin_left = 20.0
	psb.content_margin_right = 20.0
	psb.content_margin_top = 16.0
	psb.content_margin_bottom = 16.0
	panel.add_theme_stylebox_override("panel", psb)
	center.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	panel.add_child(box)
	var title := Label.new()
	title.text = Lang.t("Игра по сети")
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(20))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)
	var body := Label.new()
	body.text = Lang.t("Войдите через Яндекс, чтобы играть по сети") + "\n" \
		+ Lang.t("Без входа доступен только офлайн-режим")
	body.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_theme_font_size_override("font_size", Settings.fs(15))
	body.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	box.add_child(body)
	# Кнопки столбиком, а не в ряд: на узком экране и крупной шкале
	# ряд «Войти через Яндекс + Без входа» не влезал бы по ширине.
	var yes := _button(Lang.t("Войти через Яндекс"), 16)
	yes.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_apply_accent(yes, Color("1565C0"), Color("1976D2"), Color("0D47A1"))
	yes.pressed.connect(_on_ya_benefit_yes)
	box.add_child(yes)
	var no := _button(Lang.t("Без входа"), 16)
	no.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	no.pressed.connect(_on_ya_benefit_no)
	box.add_child(no)
	_ya_modal = dim
	_ya_panel = panel


func _show_ya_benefit() -> void:
	if _ya_modal == null:
		_build_ya_benefit()
	# Ширина панели — по вьюпорту, иначе на широком она схлопывается
	# под короткий заголовок и текст кнопок срезается (ловили вживую:
	# «Войти через Я...»). 440 хватает самой длинной кнопке.
	var vw := get_viewport_rect().size.x
	(_ya_panel as PanelContainer).custom_minimum_size = Vector2(minf(440.0, vw - 32.0), 0)
	(_ya_modal as ColorRect).visible = true


## «Войти»: модалку прячем сразу (двойное нажатие невозможно) и идём
## обычным путём — там при нужде откроется диалог SDK.
func _on_ya_benefit_yes() -> void:
	if _ya_modal != null:
		(_ya_modal as ColorRect).visible = false
	_do_ya_login()


## «Без входа» и мимо модалки — отказ от авторизации: закрываем лобби
## назад в меню. Гость играет офлайн, ничего не стираем (пп. 1, 5, 6).
func _on_ya_benefit_no() -> void:
	if _ya_modal != null:
		(_ya_modal as ColorRect).visible = false
	close()


func _on_ya_benefit_backdrop(event: InputEvent) -> void:
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		_on_ya_benefit_no()
		(_ya_modal as ColorRect).accept_event()


## Мост SDK Яндекс Игр (только Web). Один load на файл — см. константу
## YA_SDK_PATH вверху.
func _ysdk_call(method: StringName) -> void:
	var sdk = _ysdk_script()
	if sdk == null:
		_ya_log("call " + String(method) + " skipped: sdk script missing")
		return
	(sdk as GDScript).call(method)


## Загрузчик моста SDK (один load на файл — дубли rlint не любит).
func _ysdk_script():
	if not OS.has_feature("web"):
		return null
	if not ResourceLoader.exists(YA_SDK_PATH):
		return null
	return load(YA_SDK_PATH)


## Опрос флага SDK: {done: bool, ...}. Вне Web — сразу «готово».
func _ysdk_poll(kind: String) -> Dictionary:
	var sdk = _ysdk_script()
	if sdk == null:
		return {"done": true}
	if String(kind) == "auth":
		return (sdk as GDScript).poll_auth_dialog()
	if String(kind) == "sdk":
		return (sdk as GDScript).poll_sdk_ready()
	if String(kind) == "lb":
		return (sdk as GDScript).poll_lb_entries()
	return (sdk as GDScript).poll_player()


## Ждём флаг SDK (полсекундными тиками). Лобби закрыли — выходим молча.
func _ysdk_wait(kind: String, tries: int) -> bool:
	for i in range(tries):
		await get_tree().create_timer(0.5).timeout
		if not is_instance_valid(self) or not visible:
			return false
		if bool(_ysdk_poll(kind).get("done", false)):
			return true
	return false


## Единственная точка записи в строку состояния входа: текст без
## visible=true никто бы не увидел (метка создаётся скрытой), а без
## сброса цвета прогресс светился бы красным после первой же ошибки.
func _set_auth_note(text: String, is_error: bool = false) -> void:
	if _auth_note == null:
		return
	_auth_note.text = text
	_auth_note.visible = not text.is_empty()
	_auth_note.add_theme_color_override("font_color",
		Color("FF8A80") if is_error else Color(1, 1, 1, 0.7))


func _after_auth(res: Dictionary, ok_text: String) -> void:
	# Net.login/Net.register возвращают не сырое сообщение сервера, а
	# единую обёртку: {ok:true, user} либо {ok:false, reason}. Проверка
	# поля "t" тут не годится — его в обёртке нет, и успешный вход
	# выглядел бы как отказ (в сессию вошли, а страницу комнат не
	# показали, пока не переоткрыть экран).
	if bool(res.get("ok", false)):
		_set_auth_note(ok_text)
		_goto_rooms()
		return
	_set_auth_note(_reason(res, Lang.t("Не удалось войти")), true)


func _do_logout() -> void:
	await Net.logout()
	_enter_auth()


# =============================================================== список комнат

func _goto_rooms() -> void:
	_set_page(_page_rooms)
	_update_status()
	_refresh_stuck()
	if _rooms.is_empty():
		await _load_rooms()
	else:
		_render_rooms()


## Собираем список комнат со всех живых серверов.
##
## Проверка живости — здесь же: она нужна ровно для этого запроса. Если
## живых серверов нет, список всё равно не придёт, а сообщение об этом
## должно быть предметным, а не «ничего не нашлось».
## quiet — фоновый тик раз в 10 секунд: кнопки не гаснут и надпись
## «Собираем…» не мигает — иначе в момент обновления нельзя нажать
## вообще ничего. Данные (список, счётчик, пагинация) обновляются так же.
func _load_rooms(quiet := false) -> void:
	_rooms_loading = true
	if not quiet:
		_set_busy(Lang.t("Собираем список комнат…"))
	await Net.servers.probe(true)
	_update_presence()
	if not Net.servers.any_online():
		_rooms = []
		_rooms_note.text = Net.servers.offline_hint()
		_render_rooms()
		_rooms_loading = false
		if not quiet:
			_set_busy("")
		return
	# Список комнат сервер отдаёт только вошедшим, поэтому вход нужен и тут.
	# Сессия общая для всего кластера: токен, выданный на одном сервере,
	# подходит любому другому, и отдельный вход не требуется.
	var got := await Net.servers.list_rooms(Net.session_token())
	_rooms = got.get("rooms", [])
	# Данные новые — смотрим с первой страницы, иначе список мог
	# ужаться и показать пустую страницу в конце.
	_rooms_page = 0
	var failed: Array = got.get("failedServers", [])
	if failed.is_empty():
		_rooms_note.text = Lang.t("Комнат найдено: %d") % _rooms.size()
	else:
		_rooms_note.text = Lang.t("Показаны комнаты без %s. Остальные серверы не ответили.") % \
			", ".join(_failed_names(failed))
	_render_rooms()
	_rooms_loading = false
	if not quiet:
		_set_busy("")


func _failed_names(ids: Array) -> PackedStringArray:
	var out := PackedStringArray()
	for id in ids:
		var entry := Net.servers.by_id(String(id))
		out.append(Net.servers.label_of(entry) if not entry.is_empty() else String(id))
	return out


func _refresh_rooms(quiet := false) -> void:
	# Обновление уже летит (фоновый тик или кнопка): второе вдогонку
	# не запускаем — ответы перетёрли бы друг друга.
	if _rooms_loading:
		return
	await _load_rooms(quiet)


func _render_rooms() -> void:
	for child in _rooms_box.get_children():
		_rooms_box.remove_child(child)
		child.free()
	var total := _rooms.size()
	var pages := maxi(1, int(ceil(float(total) / float(ROOMS_PAGE_SIZE))))
	_rooms_page = clampi(_rooms_page, 0, pages - 1)
	if total == 0:
		var empty := Label.new()
		empty.text = Lang.t("Пока никто не создал комнату. Создайте свою.")
		empty.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		# Перенос обязателен: без него минимальная ширина равна всей
		# строке, и на большом тексте плейсхолдер растягивал
		# страницу шире экрана — правый край (Назад, Обновить) уезжал.
		empty.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		empty.add_theme_font_size_override("font_size", Settings.fs(16))
		empty.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
		_rooms_box.add_child(empty)
	else:
		var start := _rooms_page * ROOMS_PAGE_SIZE
		for i in range(start, mini(start + ROOMS_PAGE_SIZE, total)):
			_rooms_box.add_child(_make_room_row(_rooms[i] as Dictionary))
	# Пагинацию прячем, пока всё влезает на одну страницу: бабушке
	# лишние кнопки ни к чему.
	_page_row.visible = pages > 1
	_page_label.text = Lang.t("Стр. %d из %d") % [_rooms_page + 1, pages]
	_update_pagination()
	ScrollFix.relax(_rooms_box)


func _page_step(dir: int) -> void:
	var pages := maxi(1, int(ceil(float(_rooms.size()) / float(ROOMS_PAGE_SIZE))))
	_rooms_page = clampi(_rooms_page + dir, 0, pages - 1)
	_render_rooms()


func _make_room_row(room: Dictionary) -> Control:
	var row := PanelContainer.new()
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1, 1, 1, 0.05)
	sb.set_corner_radius_all(10)
	sb.border_color = Color(1, 1, 1, 0.12)
	sb.set_border_width_all(1)
	sb.content_margin_left = 10.0
	sb.content_margin_right = 10.0
	sb.content_margin_top = 6.0
	sb.content_margin_bottom = 6.0
	row.add_theme_stylebox_override("panel", sb)

	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	row.add_child(box)

	var filled := int(room.get("filled", 0))
	var seats := int(room.get("seats", 2))
	# Название комнаты и занятые места — это то, ради чего строка и нужна.
	# Название сервера сюда раньше тоже писали, но на телефоне в портрете
	# от него не оставалось ничего: длинная строка переносилась на три
	# строки и выпирала из карточки. Сервер виден отдельно, в строке
	# статуса сверху.
	var text := Lang.t("%s · %d/%d") % [String(room.get("name", "?")), filled, seats]
	# Идущую партию тоже показываем в списке: в неё можно войти вместо
	# бота. Помечать надо явно — иначе по «N/M» человека примут её за
	# лобби, где можно сесть на свободное место.
	if String(room.get("state", "")) == "playing":
		text += Lang.t(" · идёт")
	var bots := int(room.get("bots", 0))
	if bots > 0:
		text += Lang.t(" · боты %d") % bots
	if bool(room.get("hasPassword", false)):
		text += Lang.t(" · пароль")

	var lab := Label.new()
	lab.text = text
	lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lab.add_theme_font_size_override("font_size", Settings.fs(16))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	lab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	box.add_child(lab)

	var join := Button.new()
	join.text = Lang.t("Войти")
	join.custom_minimum_size = Vector2(Settings.touch_w(84), Settings.touch(38))
	join.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	join.add_theme_font_size_override("font_size", Settings.fs(16))
	join.pressed.connect(func(): _do_join(String(room.get("code", "")),
		String(room.get("server", "")), _join_pass.text))
	box.add_child(join)
	return row


func _do_join(code: String, server_id: String, password: String) -> void:
	if code.is_empty():
		return
	# Комната живёт на конкретном сервере, и партия потом будет только
	# там же. Значит, подключение надо перевести ЗАРАНЕЕ: если сначала
	# спросить «есть ли такой код?» на своём сервере, а потом
	# переподключиться, между шагами комната может закрыться, и мы
	# окажемся в лобби чужого сервера без партии.
	if not server_id.is_empty() and server_id != String(Net.server_entry().get("id", "")):
		if not await _switch_to(server_id, Lang.t("Комната на сервере %s") % server_id):
			return
	if not Net.is_logged_in():
		_enter_auth()
		return
	_set_busy(Lang.t("Заходим в %s…") % code)
	var res := await Net.join_room(code, password)
	_set_busy("")
	if _enter_from_join(res):
		return
	# Вход по коду ничего не говорит о сервере, поэтому «не найдена» на
	# текущем сервере — не ответ, а «ещё не смотрели». Обходим остальные
	# живые: иначе код, выданный на другом сервере, был бы нерабочим.
	if server_id.is_empty() and String(res.get("reason", "")) == "Комната не найдена":
		var home := String(Net.server_entry().get("id", ""))
		for other in Net.servers.online_sorted():
			var other_id := String((other["entry"] as Dictionary).get("id", ""))
			if other_id == home:
				continue
			if not await _switch_to(other_id, Lang.t("Ищем комнату")):
				return
			var again := await Net.join_room(code, password)
			if _enter_from_join(again):
				return
			# Не нашли и здесь. Возвращаемся домой: оставшись на чужом
			# сервере, мы бы молча смотрели не на тот список комнат.
			await _switch_to(home, Lang.t("Возвращаемся"))
			break
	var failed_code := String(res.get("reason", "")) == "Комната не найдена"
	if failed_code and String(Net.pending_room().get("code", "")).to_upper() == code.to_upper():
		# Возврат в комнату, которую сервер больше не знает: место за нами
		# не держится, и напоминание «вы всё ещё в комнате» врало бы.
		Net.clear_pending_room()
	_set_note(_rooms_note, _reason(res, Lang.t("Не удалось войти в комнату")), true)


## Разбор ответа на ROOM_JOIN: лобби комнаты или — если мы последним
## заполнили комнату или вошли вместо бота — уже сама партия.
## true, если ответ обработан.
func _enter_from_join(res: Dictionary) -> bool:
	match String(res.get("t", "")):
		NetProtocol.ROOM_STATE:
			_show_lobby(res.get("room", {}))
			return true
		NetProtocol.GAME_STATE:
			# Вход в идущую/только что заполненную партию: сцену меняем
			# сами (game.tscn в _ready добудет свежее состояние через
			# game.rejoin) — рассылка GAME_STATE сюда не придёт, сервер
			# исключает из неё наше место.
			_started = true
			Net.plan_game(true)
			_go_scene("res://scenes/game.tscn")
			return true
	return false


## Подключается к серверу по id. false, если сервера больше нет в списке
## или связь не поднялась — тогда звать уже некуда.
func _switch_to(id: String, why: String) -> bool:
	var entry := Net.servers.by_id(id)
	if entry.is_empty():
		_set_note(_rooms_note, Lang.t("Сервер %s больше не в списке") % id, true)
		return false
	_set_busy(Lang.t("%s: %s…") % [why, Net.servers.label_of(entry)])
	if not Net.connect_to(entry):
		_set_busy("")
		_set_note(_rooms_note, Lang.t("Не удалось подключиться к %s") % Net.servers.label_of(entry), true)
		return false
	# Соединение поднимается асинхронно: ждём готовности, иначе первый
	# же запрос уйдёт в ещё не открытый сокет.
	var deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline and Net.is_online() and not Net.is_logged_in():
		await get_tree().process_frame
	_set_busy("")
	if not Net.is_logged_in():
		_set_note(_rooms_note, Lang.t(
			"Сессия не восстановилась на %s") % Net.servers.label_of(entry), true)
		return false
	return true


func _do_create() -> void:
	if not Net.is_logged_in():
		_enter_auth()
		return
	# Комнату создаём на СЛУЧАЙНОМ живом сервере: так комнаты
	# распределяются по обеим машинам, а не копятся на одной.
	var entry := Net.servers.random_online()
	if entry.is_empty():
		_set_note(_rooms_note, Net.servers.offline_hint(), true)
		return
	if String(entry.get("id", "")) != String(Net.server_entry().get("id", "")):
		if not await _switch_to(String(entry.get("id", "")), Lang.t("Создаём комнату")):
			return
	_set_busy(Lang.t("Создаём комнату на %s…") % Net.servers.label_of(entry))
	var res := await Net.create_room(
		_seats_option.get_selected_id(), _create_require_30(), _room_name.text, _room_pass.text)
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.ROOM_STATE:
		_show_lobby(res.get("room", {}))
		return
	_set_note(_rooms_note, _reason(res, Lang.t("Не удалось создать комнату")), true)


func _do_quick() -> void:
	if not Net.is_logged_in():
		_enter_auth()
		return
	# Простой быстрый матч без очередей: обновляем список, и если есть
	# публичная комната хотя бы с одним человеком — заходим в самую
	# полную; иначе создаём свою на 4 места и сразу ждём в ней.
	await _load_rooms()
	if not Net.servers.any_online():
		return
	var target := _pick_quick_room()
	if not target.is_empty():
		await _do_join(String(target.get("code", "")),
			String(target.get("server", "")), "")
		return
	var entry := Net.servers.random_online()
	if entry.is_empty():
		_set_note(_rooms_note, Net.servers.offline_hint(), true)
		return
	if String(entry.get("id", "")) != String(Net.server_entry().get("id", "")):
		if not await _switch_to(String(entry.get("id", "")), Lang.t("Создаём комнату")):
			return
	_set_busy(Lang.t("Создаём комнату на %s…") % Net.servers.label_of(entry))
	var res := await Net.create_room(4, _create_require_30(), Lang.t("Быстрая игра"), "")
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.ROOM_STATE:
		_show_lobby(res.get("room", {}))
		return
	_set_note(_rooms_note, _reason(res, Lang.t("Не удалось создать комнату")), true)


## Кандидат для быстрого матча: публичная комната, где уже есть люди.
## Из нескольких берём самую полную — там живее всего. Пустого
## словаря нет — создавать свою.
func _pick_quick_room() -> Dictionary:
	var best := {}
	var best_filled := 0
	for r in _rooms:
		var d: Dictionary = r
		if bool(d.get("hasPassword", false)):
			continue
		var filled := int(d.get("filled", 0))
		if filled < 1:
			continue
		if filled > best_filled:
			best_filled = filled
			best = d
	return best


## Вкладки «Создать комнату» / «Войти по коду»: видна одна форма,
## в начале — ни одной. Список комнат при этом показывается всегда.
func _on_rooms_tab_toggled(_on: bool) -> void:
	_sync_rooms_tab()


func _sync_rooms_tab() -> void:
	var tab := ""
	if _tab_create_btn != null and _tab_create_btn.button_pressed:
		tab = "create"
	elif _tab_code_btn != null and _tab_code_btn.button_pressed:
		tab = "code"
	_rooms_tab = tab
	_create_box.visible = tab == "create"
	_code_box.visible = tab == "code"
	_restack_rooms()


func _create_require_30() -> bool:
	# Отдельный флажок, а не настройка одиночной игры: правило живёт
	# в комнате, и менять его молча означало бы сыграть не по тем
	# правилам, которые человек только что прочитал.
	return _require_30.button_pressed


# =============================================================== ожидание комнаты

func _show_lobby(room: Dictionary) -> void:
	if room.is_empty():
		return
	_current_room = room
	_lobby_room_code = String(room.get("code", ""))
	if visible:
		# Мы смотрим на комнату — «застрявшей» больше нет, баннеру нечего
		# показывать, а кнопки «вернуться» не нужны: мы уже внутри.
		Net.clear_pending_room()
	else:
		# Комната обновилась, пока мы в отрыве (главное меню после парковки):
		# обновляем parked-состояние, чтобы напоминания не врали и не гаснуть
		# от ROOM_STATE, который сбрасывает pending.
		Net.park_room(room)
	_set_page(_page_lobby)
	_lobby_code.text = Lang.t("Комната %s") % String(room.get("code", "?"))
	_lobby_note.text = ""
	for child in _lobby_players.get_children():
		_lobby_players.remove_child(child)
		child.free()
	var players: Array = room.get("players", [])
	var me := int(room.get("you", -1))
	# Сервер присылает ВСЕ места, включая пустые. Считать занятые надо
	# отдельно: иначе «занято» всегда равно числу мест, кнопка «Начать»
	# всегда доступна, а сервер отвечает «Занято 2 из 5» — и человек
	# бесконечно жмёт на кнопку, которая не может сработать.
	var taken := 0
	for p in players:
		var d: Dictionary = p
		var is_taken := not bool(d.get("empty", false))
		if is_taken:
			taken += 1
		var line := Label.new()
		var nick := String(d.get("nick", "?"))
		if not is_taken:
			nick = Lang.t("— свободно —")
		elif not bool(d.get("connected", true)):
			nick += Lang.t("  (нет связи)")
		if int(d.get("seat", -1)) == me:
			# Маркер своего места — «» из Latin-1, а не треугольник-стрелка:
			# геометрических фигур нет во встроенном шрифте Web-сборки
			# (был тофу-квадрат), системного фолбэка там же нет.
			# Кавычки-ёлочки весь UI уже использует — рендерятся везде.
			nick = Lang.t("» ") + nick
		line.text = Lang.t("Место %d:  %s") % [int(d.get("seat", 0)) + 1, nick]
		# Ник чужой и длинный, а без переноса строка задавала бы ширину
		# всей странице лобби — тот же выезд вправо, что и у плейсхолдера.
		line.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		line.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		line.add_theme_font_size_override("font_size", Settings.fs(15))
		line.add_theme_color_override("font_color",
			Color("90CAF9") if int(d.get("seat", -1)) == me else Color(1, 1, 1, 0.85))
		_lobby_players.add_child(line)

	var seats := int(room.get("seats", 0))
	var is_host := bool(room.get("isHost", false))
	var all_in := taken >= seats
	_lobby_all_in = all_in
	_lobby_seats.text = Lang.t("%s · свободно %d из %d · первый ход: %s") % [
		Net.server_label(), maxi(0, seats - taken), seats,
		Lang.t("от 30") if bool(room.get("require30", true)) else Lang.t("любой"),
	]
	# Боты добирают пустые места сами (при заполнении или по таймеру
	# автостарта), поэтому кнопке «Начать» вместе со всеми не нужен —
	# нужны лишь двое живых.
	_lobby_ready = taken >= 2
	_start_btn.visible = is_host
	if is_host:
		_start_btn.text = Lang.t("Начать партию") if _lobby_ready \
			else Lang.t("Ждём игроков (%d из %d)") % [taken, seats]
	_update_buttons()
	# Правило лобби: для начала нужны двое живых игроков, остальные
	# места занимают боты. Раньше тут вралось про «начнём с ботами»,
	# хотя сервер без двух людей партию не начинает.
	_auto_hint.text = Lang.t("Для начала нужны двое живых игроков — остальные места займут боты.")
	# Сервер всё равно не начнёт, пока не придут двое и не все будут на
	# связи, — но сказать об этом заранее честнее, чем ловить отказ.
	_set_note(_lobby_note,
		(Lang.t("Все на месте. %s") % (Lang.t("Начинайте.") if is_host else Lang.t("Ждём, начнёт хост.")))
		if all_in else (Lang.t("Ждём остальных игроков (%d из %d).") % [taken, seats]),
		false)
	ScrollFix.relax(_lobby_players)


func _do_start() -> void:
	_set_busy(Lang.t("Начинаем…"))
	var res := await Net.start_room()
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.GAME_STATE:
		# Хосту сервер шлёт ЛИЧНЫЙ ответ с его рукой, но не рассылку
		# (broadcastRoom исключает его место) — из-за этого _on_net_game_state
		# у хоста не срабатывает, и без явного перехода хост застревал в
		# лобби после нажатия «Начать партию». Сцену меняем здесь же.
		_started = true
		Net.plan_game(true)
		_go_scene("res://scenes/game.tscn")
		return
	_set_note(_lobby_note, _reason(res, Lang.t("Не удалось начать партию")), true)


func _do_leave_room() -> void:
	await Net.leave_room()
	_goto_rooms()


# ----------------------------------------------------------------- возврат


## Баннер «вы всё ещё в комнате». Показывается на странице комнат, когда
## сервер сообщил, что игрок числится в комнате/партии (мягкий выход,
## вход в аккаунт при живом месте), а сам возвращать его не стал.
func _refresh_stuck(_room := {}) -> void:
	if _stuck_box == null:
		return
	var pending := Net.pending_room()
	if pending.is_empty():
		_stuck_box.visible = false
		return
	var code := String(pending.get("code", "?"))
	var playing := String(pending.get("state", "")) == "playing"
	_stuck_label.text = Lang.t("Вы всё ещё в комнате %s: %s. ") % [code, _stuck_where(pending)]
	_stuck_label.text += Lang.t("Вернитесь в неё или покиньте насовсем.")
	_return_btn.text = Lang.t("Вернуться в партию") if playing else Lang.t("Вернуться в комнату")
	_stuck_box.visible = true
	# Текст кнопки сменился — вместе с ним пересчитываем и ряд:
	# ширина кнопок зависит от подписи («в партию» / «в комнату»).
	if _stuck_row != null and _avail_w > 0.0:
		_stack(_stuck_row, not _fits(_stuck_row, _avail_w))
	_update_buttons()


## Куда зовём из баннера: партия идёт, люди в сборе — или игрок один.
## Одного «игроки в сборе» врало бы: человек ждал бы несуществующих.
func _stuck_where(pending: Dictionary) -> String:
	if String(pending.get("state", "")) == "playing":
		return Lang.t("партия идёт")
	if not pending.has("players"):
		return Lang.t("игроки в сборе")
	var n := 0
	for p in pending.get("players", []):
		if p is Dictionary and not bool((p as Dictionary).get("empty", false)):
			n += 1
	if n <= 1:
		return Lang.t("кроме вас никого нет")
	return Lang.t("игроки в сборе")


## «Вернуться» с баннера. Для партии — просто открываем сцену: свежее
## состояние она добудет сама (game.rejoin в _ready / после переподключения)
## и почистит pending. Для лобби — обычный вход по коду комнаты.
func _do_return_room() -> void:
	var pending := Net.pending_room()
	if String(pending.get("state", "")) == "playing":
		if not Net.is_online():
			# Без связи сцена партии в _ready ушла бы в локальную игру, а
			# это не «вернуться в партию». Лучше честно сказать, что связи нет.
			_set_note(_rooms_note, Lang.t("Нет связи с сервером: вернуться в партию пока нельзя"), true)
			return
		Net.plan_game(true)
		_go_scene("res://scenes/game.tscn")
		return
	if not String(pending.get("code", "")).is_empty():
		await _do_join(String(pending.get("code", "")), "", "")


## «Покинуть комнату» с баннера: полный выход из лобби или партии, место
## освобождается сразу, вернуть игрока в неё уже никто не сможет.
## true, если комната покинута; false, если сервер отказал и причина
## выведена в _rooms_note.
func _do_drop_room() -> bool:
	_set_busy(Lang.t("Покидаем комнату…"))
	var res := await Net.drop_room()
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.ROOM_LEFT:
		return true
	_set_note(_rooms_note, _reason(res, Lang.t("Не удалось покинуть комнату")), true)
	return false


## Точка входа из главного меню: «Вернуться в игру». Для партии — просто
## открываем сцену (состояние она добудет сама). Для комнаты — открываем
## сетевой экран и заходим в комнату, чтобы игрок увидел, куда пришёл.
func return_to_room() -> void:
	var pending := Net.pending_room()
	if String(pending.get("state", "")) == "playing":
		if not Net.is_online():
			# Без связи предупреждение должно быть видно: открываем сетевой
			# экран, и _do_return_room скажет там, что вернуться пока нельзя.
			open()
		_do_return_room()
		return
	open()
	_do_return_room()


## Точка входа из главного меню: «Покинуть комнату» — полный выход, место
## освобождается сразу, баннер и напоминание гаснут вместе с pending.
## Неудачу (например, нет связи) показываем на видимом сетевом экране,
## а не глотаем в скрытом.
func drop_room_now() -> void:
	if not await _do_drop_room():
		open()


# =============================================================== вёрстка

## Подгонка разметки под реальный размер окна.
##
## Окно на телефоне не 576×1024, как в редакторе: у него своя ширина,
## и игрок ещё и поворачивает. Раньше ширина разметки была зашита
## (496), из-за чего на экранах уже 576−28−12 заголовок уезжал под
## правый край и обрезался, а поля «название»/«пароль» сжимались в
## нечитаемые полоски. Теперь ширину берём у окна, а ряды из двух-трёх
## контролов на узком экране складываем в столбик.
##
## Вызывается при повороте экрана и смене текстовой шкалы, поэтому
## дешёвые проверки «ничего не изменилось» здесь обязательны.
func _relayout() -> void:
	if _root == null or _title == null:
		return
	var vp := get_viewport()
	if vp == null:
		return
	# Поля 14+14 и вертикальная полоса прокрутки ~12 — как в _build.
	var avail := vp.get_visible_rect().size.x - 28.0 - 12.0
	if avail <= 0.0:
		return
	avail = minf(avail, 576.0)
	# Ширина окна недостаточна для проверки «ничего не изменилось»:
	# та же ширина при другой текстовой шкале требует другой вёрстки, а
	# шкала меняется в главном меню, пока лобби скрыто.
	var scale := Settings.text_scale
	if is_equal_approx(avail, _avail_w) and scale == _last_scale:
		return
	_avail_w = avail
	_last_scale = scale
	_root.custom_minimum_size = Vector2(avail, 0)

	# Заголовок ужимается под «Назад», а не обрезается: font_size
	# спускаем, пока строка не влезет в отведённую ей ширину. Считаем
	# по get_string_size того же шрифта, что рисует Label. Ширину
	# кнопки берём из custom_minimum_size, а не из size: на первом
	# проходе разметка ещё не посчитана и size.x у кнопки нулевой —
	# заголовок решил бы, что ему места сколько угодно.
	var base := Settings.fs(22)
	# Место считаем от доступной ширины, а не от реальной ширины ряда:
	# ряд может быть уже растянут широким содержимым, и тогда заголовок
	# разжимался бы обратно во всю ширь, а за ним — и вся страница.
	var room_for_title := avail - _back_btn.custom_minimum_size.x - 10.0
	var size := base
	var font := _title.get_theme_font("font")
	if font != null and room_for_title > 40.0:
		while size > Settings.FS_MIN:
			if font.get_string_size(_title.text,
					HORIZONTAL_ALIGNMENT_LEFT, -1, size).x <= room_for_title:
				break
			size -= 1
	_title.add_theme_font_size_override("font_size", size)

	# Ряд складывается не по «ширине экрана», а по тому, влезают ли его
	# дети в строку: при aspect=expand вьюпорт уже базовой ширины, но на
	# большом тексте места в нём вдвое меньше, чем нужно. Порог —
	# сумма минимальных ширин детей, иначе «название (необязательно)»
	# получает треть экрана и обрезается.
	for row in _stack_rows:
		_stack(row as BoxContainer, not _fits(row as BoxContainer, avail))
	ScrollFix.relax(_root)


## Пересчитать складывание рядов под текущую видимость: вкладки
## показывают формы, очередь — строку статуса, и решение «влезает ли
## ряд», принятое при другой видимости, уже врёт.
func _restack_rooms() -> void:
	if _avail_w <= 0.0:
		return
	for row in _stack_rows:
		var box := row as BoxContainer
		_stack(box, not _fits(box, _avail_w))


## Влезают ли дети ряда в строку шириной avail. Считаем минимальные
## ширины тех же шрифтов и размеров, что и движок, иначе решение
## принималось бы по старым значениям.
func _fits(row: BoxContainer, avail: float) -> bool:
	var need := 0.0
	var gap := float(row.get_theme_constant("separation"))
	var first := true
	for item in row.get_children():
		var c := item as Control
		# Именно c.visible, а не is_visible_in_tree: страница комнат
		# в момент перевёрстки может быть скрыта (мы на странице входа
		# или в лобби), и решение «влезает ли ряд» принялось бы по
		# пустому списку — ряд остался бы в строке до следующего
		# поворота экрана.
		if c == null or not c.visible:
			continue
		need += _need(c)
		if not first:
			need += gap
		first = false
	return need <= avail


## Один ряд: горизонтально или столбиком. Переключение — один флаг
## BoxContainer, а не пересборка дерева: состояние полей и нажатия при
## этом не теряются.
func _stack(row: BoxContainer, narrow: bool) -> void:
	if row == null:
		return
	row.vertical = narrow
	row.add_theme_constant_override("separation", 6 if narrow else 8)
	for item in row.get_children():
		var c := item as Control
		if c == null:
			continue
		# Исходные флаги запоминаем: разложенный ряд должен выглядеть
		# ровно как раньше, иначе «мест: 3» в разложенном ряду растянулся
		# бы на всю ширину и поехала вёрстка широких экранов.
		if not c.has_meta("h_flags_before_stack"):
			c.set_meta("h_flags_before_stack", c.size_flags_horizontal)
		# В столбике каждый контрол тянется на всю ширину страницы.
		c.size_flags_horizontal = Control.SIZE_EXPAND_FILL if narrow \
			else int(c.get_meta("h_flags_before_stack"))
		# Ширина по содержимому — только в строку: в столбике минимум
		# держим нулевым, иначе длинная подпись на большом тексте
		# разорвёт страницу шире экрана. В строке же кнопке с clip_text
		# и пустому полю минимум по содержимому обязателен: иначе
		# контейнер выдаст им 8 px, и текст срежется полностью.
		if (c is Button and not (c is OptionButton)) or c is LineEdit:
			if not c.has_meta("wide_min_x"):
				c.set_meta("wide_min_x", c.custom_minimum_size.x)
			var cur := c.custom_minimum_size
			if narrow:
				c.custom_minimum_size = Vector2(0, cur.y)
			else:
				var sample := ""
				if c is LineEdit:
					var e := c as LineEdit
					sample = e.text if not e.text.is_empty() \
						else e.placeholder_text
				else:
					sample = (c as Button).text
				var want := float(c.get_meta("wide_min_x"))
				if not sample.is_empty():
					want = maxf(want, _text_content_width(c, sample))
				c.custom_minimum_size = Vector2(want, cur.y)


# =============================================================== общие мелочи

func _set_page(page: VBoxContainer) -> void:
	for p in [_page_auth, _page_rooms, _page_lobby]:
		(p as Control).visible = p == page
	_update_status()


## Спрятать все страницы (фон быстрого Web-входа: пустая шапка + модалка).
func _hide_all_pages() -> void:
	for p in [_page_auth, _page_rooms, _page_lobby]:
		(p as Control).visible = false


func _set_busy(text: String) -> void:
	_busy_flag = not text.is_empty()
	_set_note(_busy, text, false)
	_update_buttons()


func _all_buttons() -> Array:
	var out: Array = []
	_walk_buttons(self, out)
	return out


func _walk_buttons(node: Node, out: Array) -> void:
	if node is Button:
		out.append(node)
	for child in node.get_children():
		_walk_buttons(child, out)


## Состояние ВСЕХ кнопок вычисляется здесь, целиком, каждый раз заново.
##
## Раньше _set_busy гасил всё подряд, а оживлял по списку — и кнопки,
## в списк не попавшие («Назад», «Начать партию», «Войти» в строках
## списка комнат), после первого же запроса оставались мёртвыми навсегда.
## Списка тут принципиально нет: сначала гасим всё, потом точечно
## разрешаем то, что сейчас имеет смысл.
##
## Что живёт даже во время запроса (busy), а что нет:
##  - «Назад», закрытие модалки таблицы, отмена подтверждения, вкладки
##    «Создать/по коду» и пагинация — живут: они состояние не меняют
##    (страницы, закрытия, локальный перелист), и гасить их — значит
##    запирать игрока на время каждого обновления списка;
##  - вход/регистрация, создать/быстрая/по коду/старт/покинуть, выйти,
##    удалить, вернуться/покинуть зависшее, обновить список — гаснут:
##    это запросы и смена сессий, второй вдогонку всё бы испортил.
func _update_buttons() -> void:
	var busy := _busy_flag
	# Для входа нужен не просто открытый сокет, а приветствие сервера:
	# сокет открывается на целый круг раньше первого пакета. Кнопка,
	# разрешённая по одному сокету, предлагала игроку клик, который
	# заведомо не мог сработать.
	var linked := Net.is_greeted()
	var authed := Net.is_logged_in()
	for node in _all_buttons():
		(node as Button).disabled = busy
	# «Назад» остаётся живым даже во время запроса: из экрана, который
	# ждёт ответа сервера, должен быть выход.
	_back_btn.disabled = false
	# Закрытия и отмена — тоже выходы, а не запросы: модалку должно
	# быть можно закрыть всегда (фон по клику и так закрывается).
	if _board_close_btn != null:
		_board_close_btn.disabled = false
	if _del_cancel != null:
		_del_cancel.disabled = false
	# Вкладки — переключение форм без сети: во время обновления списка
	# (и любого запроса) им гаснуть не с чего.
	if _tab_create_btn != null:
		_tab_create_btn.disabled = false
	if _tab_code_btn != null:
		_tab_code_btn.disabled = false
	# Открытие таблицы — тоже чтение: модалка грузит свои данные сама,
	# закрытие — рядом в том же списке.
	if _board_btn != null:
		_board_btn.disabled = false
	_update_pagination()
	_login_btn.disabled = busy or not linked
	_register_btn.disabled = busy or not linked
	if _ya_btn != null:
		_ya_btn.disabled = busy or not linked or _ya_busy
	# Обновить во время обновления — бессмысленный дубль: следующее
	# нажатие подождёт конца летящего запроса.
	_refresh_btn.disabled = busy or _rooms_loading or not linked
	_create_btn.disabled = busy or not authed
	_play_btn.disabled = busy or not authed
	_join_btn.disabled = busy or not authed
	_start_btn.disabled = busy or not authed or not _lobby_ready
	_leave_btn.disabled = busy or not authed
	# Баннер «вы всё ещё в комнате»: кнопки живут, только когда есть что
	# возвращать. Внутри запроса (busy) они гаснут вместе со всеми.
	var stuck := not Net.pending_room().is_empty()
	_return_btn.disabled = busy or not stuck
	_drop_btn.disabled = busy or not stuck
	_join_code.editable = authed and not busy
	_join_pass.editable = authed and not busy


## Пагинация — локальный перелист, запросом не является: границы
## применяем поверх любых гашений (и спокойных, и busy).
func _update_pagination() -> void:
	if _page_prev == null or _page_next == null:
		return
	var pages := maxi(1, int(ceil(float(_rooms.size()) / float(ROOMS_PAGE_SIZE))))
	_page_prev.disabled = _rooms_page <= 0
	_page_next.disabled = _rooms_page >= pages - 1


func _update_status() -> void:
	var text := Lang.t("Сервер: %s") % Net.server_label()
	var warn := false
	if not Net.is_online():
		text = Lang.t("Нет связи с сервером")
		warn = true
	elif not Net.is_greeted():
		# Сокет поднят, но сервер ещё не поздоровался. Молчать тут
		# нельзя: игрок видит серые кнопки и ждёт, что сломалось.
		text += Lang.t(" · подключение…")
	elif Net.is_logged_in():
		text += Lang.t(" · %s") % Net.session_nick()
	_set_note(_status, text, warn)


## Список серверов с пингами. Раньше он занимал отдельные строки под
## статусом и на странице комнат съедал высоту, которой там и так мало:
## на телефоне в портрете список комнат уезжал за нижний край экрана.
## Теперь он рисуется одной строкой, а состояние сервера видно по
## строке статуса — там уже написано, какой сервер активен.
func _update_presence() -> void:
	for child in _server_box.get_children():
		_server_box.remove_child(child)
		child.free()
	var health := Net.servers.health()
	if health.is_empty():
		return
	var up := 0
	for id in health:
		if bool((health[id] as Dictionary).get("online", false)):
			up += 1
	var total := health.size()
	if up == total:
		return
	var lab := Label.new()
	lab.text = Lang.t("Серверов в сети: %d из %d") % [up, total]
	lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	lab.add_theme_font_size_override("font_size", Settings.fs(13))
	lab.add_theme_color_override("font_color", Color("FF8A80"))
	_server_box.add_child(lab)
	ScrollFix.relax(_server_box)


func _reason(res: Dictionary, fallback: String) -> String:
	var text := String(res.get("reason", ""))
	if text.is_empty():
		match String(res.get("t", "")):
			"offline":
				return Lang.t("Нет связи с сервером")
			"timeout":
				return Lang.t("Сервер не ответил вовремя")
			NetProtocol.AUTH_ERR:
				return Lang.t("Не удалось войти")
	# Причина с провода (сервер всегда шлёт русский) — через словарь.
	return Lang.t(text) if not text.is_empty() else fallback


func _set_note(label: Label, text: String, warn: bool) -> void:
	if label == null:
		return
	label.text = text
	label.visible = not text.is_empty()
	label.add_theme_color_override("font_color",
		Color("FF8A80") if warn else Color(1, 1, 1, 0.7))


func _apply_accent(button: Button, normal: Color, hover: Color, pressed: Color) -> void:
	for pair in [["normal", normal], ["hover", hover], ["pressed", pressed]]:
		var sb := StyleBoxFlat.new()
		sb.bg_color = pair[1]
		sb.set_corner_radius_all(10)
		sb.content_margin_left = 12.0
		sb.content_margin_right = 12.0
		sb.content_margin_top = 6.0
		sb.content_margin_bottom = 6.0
		button.add_theme_stylebox_override(String(pair[0]), sb)
	button.add_theme_color_override("font_color", Color.WHITE)
	button.add_theme_color_override("font_hover_color", Color.WHITE)
	button.add_theme_color_override("font_pressed_color", Color.WHITE)
	button.add_theme_color_override("font_disabled_color", Color(1, 1, 1, 0.35))


## Кнопка с акцентной подложкой и честным минимумом по тексту. Красим
## ДО замера ширины: замер берёт поля из текущей подложки, а подложка
## добавляет боковые 12+12 — замер по дефолтной срезал бы пару букв
## (ловили на «Удалить аккаунт» на странице комнат).
func _accent_button(text: String, size: int, normal: Color, hover: Color,
		pressed: Color) -> Button:
	var b := _button(text, size)
	_apply_accent(b, normal, hover, pressed)
	b.custom_minimum_size.x = _text_content_width(b, b.text)
	return b


## wrap = false для коротких заголовков в один ряд (например «ИГРА ПО
## СЕТИ»): перенос разбивал их на отдельные слова, а сжимать шрифт до
## размера остальных заголовков не хочется — лучше обрезать по краю.
func _header(text: String, size: int = 17, wrap := true) -> Label:
	var lab := Label.new()
	lab.text = text
	lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# Заголовки — обычные подписи и длинные пояснения («Сервер
	# выбирается случайно…»). Без переноса пояснение задавало ширину
	# всей страницы лобби и уезжало за правый край на крупных шкалах.
	lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART if wrap \
			else TextServer.AUTOWRAP_OFF
	lab.clip_text = not wrap
	lab.add_theme_font_size_override("font_size", Settings.fs(size))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	return lab


func _field(placeholder: String, secret := false) -> LineEdit:
	var edit := LineEdit.new()
	edit.placeholder_text = placeholder
	edit.custom_minimum_size = Vector2(0, Settings.touch(44))
	edit.add_theme_font_size_override("font_size", Settings.fs(15))
	edit.secret = secret
	return edit


## Боковые поля вкладок «Создать комнату» / «Войти по коду»: шире
## дефолта, чтобы по широкой кнопке было удобно попадать пальцем.
## Цвета и форму не трогаем — дублируем эффективные стильбоксы темы
## (все состояния, включая нажатое у тоггла) и правим только поля.
## Вызывать после сборки в дереве: стильбоксы берутся из темы.
const TAB_SIDE_PAD := 28.0


func _pad_tabs() -> void:
	for b in [_tab_create_btn, _tab_code_btn]:
		if b == null:
			continue
		for state in ["normal", "hover", "pressed", "disabled", "focus"]:
			var src := (b as Button).get_theme_stylebox(state)
			if src is StyleBoxFlat:
				var sb := (src as StyleBoxFlat).duplicate() as StyleBoxFlat
				sb.content_margin_left = maxf(sb.content_margin_left, TAB_SIDE_PAD)
				sb.content_margin_right = maxf(sb.content_margin_right, TAB_SIDE_PAD)
				(b as Button).add_theme_stylebox_override(state, sb)


func _button(text: String, size: int = 15) -> Button:
	var b := Button.new()
	b.text = text
	b.clip_text = true
	b.custom_minimum_size = Vector2(0, Settings.touch(48))
	b.add_theme_font_size_override("font_size", Settings.fs(size))
	return b


## Ширина строки тем же шрифтом и размером, что рисует контрол,
## плюс поля его стиля. Нужна, чтобы задать честный минимум тем,
## у кого движок его занижает (кнопки с clip_text, пустые поля).
func _text_content_width(c: Control, sample: String) -> float:
	var w := 0.0
	var font: Font = c.get_theme_font("font")
	if font != null:
		w = font.get_string_size(sample, HORIZONTAL_ALIGNMENT_LEFT, -1,
			c.get_theme_font_size("font_size")).x
	var sb := c.get_theme_stylebox("normal")
	if sb != null:
		w += sb.content_margin_left + sb.content_margin_right
	else:
		w += 16.0
	return w


## Честная ширина ребёнка ряда: у кнопки с clip_text и у пустого поля
## движок минимум по содержимому не считает, и ряд с ними всегда
## «влезал» — кнопки сжимались до полосок в 8 px с полностью срезанным
## текстом, а поля названия/пароля делили узкий экран на полоски.
## Минимумы при этом держим маленькими специально: большой минимум
## на большом тексте разорвал бы страницу шире экрана, а в столбике
## каждый контрол и так тянется на всю ширину.
func _need(c: Control) -> float:
	var base := c.get_combined_minimum_size().x
	var sample := ""
	if c is LineEdit:
		var e := c as LineEdit
		sample = e.text if not e.text.is_empty() else e.placeholder_text
	elif c is Button and not (c is OptionButton):
		sample = (c as Button).text
	if sample.is_empty():
		return base
	return maxf(base, _text_content_width(c, sample))


# =============================================================== сборка интерфейса

func _build() -> void:
	if _overlay != null:
		return
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	# Единый вид кнопок (скругление 10) — дальше по дереву наследуют все.
	theme = UiThemeClass.shared()
	visible = false
	mouse_filter = Control.MOUSE_FILTER_STOP

	_overlay = ColorRect.new()
	_overlay.color = Color("12151C")
	_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(_overlay)

	# Разметка — MarginContainer на весь экран, а НЕ CenterContainer.
	#
	# CenterContainer отдаёт ребёнку ровно его минимальный размер. У
	# прокручиваемого ScrollContainer минимум по вертикали равен нулю
	# (иначе он не прокручивал бы), поэтому CenterContainer давал ему
	# высоту 0 — и весь экран превращался в один тёмный прямоугольник:
	# наложение рисуется, а содержимое обрезано по нулевой высоте.
	# Главное меню от этого спасалось вручную (main_menu._sync_scroll_min),
	# здесь такой подпорки не было ни разу.
	#
	# MarginContainer занимает весь экран и отдаёт ScrollContainer всё
	# оставшееся место, а тот раздаёт его содержимому. Размер считает
	# движок, подгонять его вручную больше не нужно и незачем: такой
	# подпор забывают переписать, стоит content_min измениться.
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 14)
	margin.add_theme_constant_override("margin_right", 14)
	margin.add_theme_constant_override("margin_top", 12)
	margin.add_theme_constant_override("margin_bottom", 12)
	_overlay.add_child(margin)

	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	margin.add_child(scroll)

	# 496, а не 520: вертикальная полоса прокрутки съедает около 12 px, и
	# при минимуме 520 содержимое переставало бы помещаться и обрезалось
	# справа. Поля 14 + 14 плюс 496 — как раз 524, окно игры 576.
	var root := VBoxContainer.new()
	_root = root
	# Ширину задаёт _relayout по фактическому размеру окна. Раньше здесь
	# стояли жёсткие 496, и на экранах уже 576-28-12 содержимое уезжало
	# под правый край, а на ещё более узких обрезалось по полям входа.
	# Ноль на старте — иначе ScrollContainer посчитал бы свою ширину по
	# нулю и дал корню 0, а _relayout ещё не успел отработать.
	root.custom_minimum_size = Vector2(496, 0)
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_theme_constant_override("separation", 10)
	# Контейнер лобби не ловит касание: иначе жест упирается в него и
	# список комнат/игроков не проскроллить пальцем.
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	scroll.add_child(root)

	_head = HBoxContainer.new()
	_head.add_theme_constant_override("separation", 10)
	root.add_child(_head)
	# Короткий заголовок в один ряд с кнопкой «Назад»: перенос разбивал
	# его на «ИГРА / ПО / СЕТИ», поэтому он не переносится вовсе. Шрифт
	# ему подбирает _relayout — на узком экране он ужимается сам,
	# иначе надпись обрезается по краю.
	_title = _header(Lang.t("ИГРА ПО СЕТИ"), 22, false)
	# Заголовок тянется на всё, что осталось после «Назад», и никакого
	# распорки-распорки между ними: у Label с clip_text минимальная
	# ширина нулевая, поэтому пустое место перед кнопкой забирал себе
	# он, а обрезался заголовок.
	_head.add_child(_title)
	_back_btn = _button(Lang.t("Назад"), 16)
	_back_btn.custom_minimum_size = Vector2(Settings.touch_w(110), Settings.touch(40))
	_back_btn.pressed.connect(close)
	_head.add_child(_back_btn)

	# Перенос обязателен: у Label без autowrap минимальная ширина равна
	# всей строке, а «Сервер: <длинное имя> · <ник>» на узком экране
	# растягивал корень шире окна — и вместе с ним уезжали вправо все
	# страницы. Перенос не даёт строке стать шириной макета.
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_font_size_override("font_size", Settings.fs(15))
	root.add_child(_status)
	_busy = Label.new()
	_busy.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_busy.add_theme_font_size_override("font_size", Settings.fs(15))
	_busy.visible = false
	root.add_child(_busy)

	_server_box = VBoxContainer.new()
	_server_box.add_theme_constant_override("separation", 2)
	# Пустой контейнер без флагов схлопывается в ноль по ширине, и
	# строки серверов потом рисуются по содержимому, а не во всю
	# ширину экрана. Флаг задаётся сразу, на пустом.
	_server_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_child(_server_box)

	_page_auth = _build_auth()
	_page_rooms = _build_rooms()
	_page_lobby = _build_lobby()
	root.add_child(_page_auth)
	root.add_child(_page_rooms)
	root.add_child(_page_lobby)

	Net.connection_changed.connect(_on_net_connection)
	# Приветствие — момент, когда вход на сервере становится возможен:
	# кнопки «Войти»/«Создать аккаунт» считаются один раз в _build, пока
	# is_greeted() ещё false, и без подписки остаются серыми навсегда.
	Net.greeted.connect(_on_net_greeted)
	Net.room_state.connect(_on_net_room_state)
	Net.room_closed.connect(_on_net_room_left)
	Net.game_state.connect(_on_net_game_state)
	Net.pending_room_changed.connect(_refresh_stuck)
	_tick = Timer.new()
	_tick.wait_time = HEALTH_TICK_S
	_tick.autostart = false
	_tick.timeout.connect(_on_tick)
	add_child(_tick)
	# Список комнат сам не молодеет: раз в 10 секунд молча освежаем,
	# пока смотрим на него. Только чтение и только в покое — посреди
	# запроса, чужой страницы или без входа не дёргаем сеть.
	_rooms_timer = Timer.new()
	_rooms_timer.wait_time = 10.0
	_rooms_timer.autostart = false
	_rooms_timer.timeout.connect(_on_rooms_tick)
	add_child(_rooms_timer)
	_set_page(_page_auth)
	_refresh_stuck()
	_update_buttons()
	_pad_tabs()
	_build_ya_benefit()
	# Страницы лобби, строки серверов и комнат — контейнеры, а не кнопки:
	# без этого палец упирается в них и лобби не листается.
	ScrollFix.relax(root)


## Периодически освежаем «кто на связи». Отдельный таймер, а не ожидание
## события: сервер умирает молча, и без проверки меню минутами обещает
## связь с машиной, которой уже нет.
func _on_tick() -> void:
	if not visible:
		return
	_refresh_presence()
	if not Net.is_online() and Net.has_session():
		# Сокет молча упал, а сессия на месте — пробуем вернуться.
		# Именно is_online, а не is_linked: пока идёт рукопожатие, сокет
		# ещё не открыт, и проверка по is_linked сочла бы нормальную
		# попытку обрывом — а _do_connect на этом сокет пересоздал бы,
		# и подключение не началось бы никогда.
		_do_connect()


## Раз в 10 секунд молча освежаем список комнат, пока на него смотрим.
## Только чтение и только в покое: посреди запроса, на чужой странице,
## без входа или без связи сеть не дёргаем. Тихо (quiet): кнопки при
## этом не гаснут.
func _on_rooms_tick() -> void:
	if not visible or _page_rooms == null or not _page_rooms.visible:
		return
	if _busy_flag or _rooms_loading or not Net.is_logged_in():
		return
	await _refresh_rooms(true)


## Проверяет живость серверов и перерисовывает строку статуса.
## Отдельная от _update_presence, потому что проверка ходит в сеть и
## занимает до двух с половиной секунд — на это время экран должен
## остаться живым, а не замереть.
func _refresh_presence() -> void:
	await Net.servers.probe(false)
	if visible:
		_update_presence()


func _build_auth() -> VBoxContainer:
	var page := VBoxContainer.new()
	# 12 между смысловыми блоками (заголовок, поля, кнопки), внутри
	# групп — свои мелкие отступы. Вертикаль прокручивается, так что
	# воздух дешёвый, а слипшиеся блоки читать тяжело.
	page.add_theme_constant_override("separation", 12)
	page.visible = false

	page.add_child(_header(Lang.t("Вход"), 19))
	_login_edit = _field(Lang.t("логин"))
	page.add_child(_login_edit)
	_pass_edit = _field(Lang.t("пароль"), true)
	# Набранный пароль запоминаем сразу, а не только по кнопке
	# «Войти»: игрок может закрыть игру, не доходя до входа, и
	# рассчитывать, что в следующий раз поле уже заполнено.
	_pass_edit.text_changed.connect(_on_pass_typed)
	page.add_child(_pass_edit)
	page.add_child(_header(Lang.t("Если аккаунта нет"), 15))
	_nick_edit = _field(Lang.t("имя в игре"))
	page.add_child(_nick_edit)

	_login_btn = _button(Lang.t("Войти"), 17)
	_login_btn.pressed.connect(_do_login)
	_apply_accent(_login_btn, Color("1565C0"), Color("1976D2"), Color("0D47A1"))
	page.add_child(_login_btn)

	_register_btn = _button(Lang.t("Регистрация"), 15)
	_register_btn.pressed.connect(_do_register)
	page.add_child(_register_btn)
	# Парольный вход целиком — одним списком: на Web прячем всё разом
	# (требование 1.2: авторизация только через Yandex ID).
	_auth_form = []
	for ch in page.get_children():
		_auth_form.append(ch)

	_auth_ya_box = VBoxContainer.new()
	_auth_ya_box.add_theme_constant_override("separation", 12)
	_auth_ya_box.visible = false
	_auth_ya_box.add_child(_header(Lang.t("Онлайн через Яндекс ID"), 19))
	var ya_note := Label.new()
	ya_note.text = Lang.t("Войдите через Яндекс, чтобы играть по сети")
	ya_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	ya_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	ya_note.add_theme_font_size_override("font_size", Settings.fs(15))
	_auth_ya_box.add_child(ya_note)
	var ya_note2 := Label.new()
	ya_note2.text = Lang.t("Прогресс и статистика сохранятся в облаке")
	ya_note2.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	ya_note2.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	ya_note2.add_theme_font_size_override("font_size", Settings.fs(15))
	_auth_ya_box.add_child(ya_note2)
	_ya_btn = _button(Lang.t("Войти через Яндекс"), 17)
	_ya_btn.pressed.connect(_do_ya_login)
	_apply_accent(_ya_btn, Color("1565C0"), Color("1976D2"), Color("0D47A1"))
	_auth_ya_box.add_child(_ya_btn)
	page.add_child(_auth_ya_box)

	_auth_note = Label.new()
	_auth_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	# Метка с автопереносом без заданной ширины схлопывается до одного
	# пикселя: переносить ей не по чему, и текст обрезается по символу.
	# Ширину обязаны давать флагом, иначе причина «пустого места»
	# неотличима от «текста нет».
	_auth_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_auth_note.add_theme_font_size_override("font_size", Settings.fs(15))
	_auth_note.visible = false
	page.add_child(_auth_note)
	_sync_auth_mode()
	return page


func _build_rooms() -> VBoxContainer:
	var page := VBoxContainer.new()
	# 12 между смысловыми блоками (баннер, игра, вкладки, список, выход),
	# внутри групп — свои мелкие отступы. См. комментарий в _build_auth.
	page.add_theme_constant_override("separation", 12)
	page.visible = false

	# --- «вы всё ещё в комнате»: мягко вышедшего из партии игрока сервер
	# не возвращает сам, но и не выписывает молча — место держится за ним.
	# Баннер показывает это прямо на странице комнат и отдаёт два выхода:
	# вернуться или покинуть комнату с концами.
	_stuck_box = PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color("3E2723", 0.95)
	sb.corner_radius_top_left = 8
	sb.corner_radius_top_right = 8
	sb.corner_radius_bottom_left = 8
	sb.corner_radius_bottom_right = 8
	sb.content_margin_left = 12
	sb.content_margin_right = 12
	sb.content_margin_top = 10
	sb.content_margin_bottom = 10
	_stuck_box.add_theme_stylebox_override("panel", sb)
	_stuck_box.visible = false
	page.add_child(_stuck_box)
	var stuck_inner := VBoxContainer.new()
	stuck_inner.add_theme_constant_override("separation", 6)
	_stuck_box.add_child(stuck_inner)
	_stuck_label = Label.new()
	_stuck_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_stuck_label.add_theme_font_size_override("font_size", Settings.fs(15))
	_stuck_label.add_theme_color_override("font_color", Color("FFE0B2"))
	stuck_inner.add_child(_stuck_label)
	# Ряд, а не HBoxContainer: направление у него переключается в
	# _relayout, а у HBoxContainer vertical менять нельзя вовсе.
	var stuck_row := BoxContainer.new()
	_stuck_row = stuck_row
	stuck_row.add_theme_constant_override("separation", 8)
	stuck_inner.add_child(stuck_row)
	_stack_rows.append(stuck_row)
	# Две кнопки в ряд на узком экране сжимаются в «ВернутьсяПокинуть» —
	# ряд складывается в столбик в _relayout.
	_return_btn = _button(Lang.t("Вернуться"), 16)
	_return_btn.pressed.connect(_do_return_room)
	_apply_accent(_return_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	stuck_row.add_child(_return_btn)
	_drop_btn = _button(Lang.t("Покинуть"), 16)
	_drop_btn.pressed.connect(_do_drop_room)
	stuck_row.add_child(_drop_btn)

	# --- быстрая игра: одна большая кнопка вместо мелкого «Быстрый».
	# Параметры очереди (места, «от 30») берутся из формы создания ниже:
	# она может быть скрыта за вкладкой, но значения в контролах живут.
	_play_btn = _button(Lang.t("Играть по сети"), 20)
	_play_btn.custom_minimum_size = Vector2(0, Settings.touch(58))
	_play_btn.pressed.connect(_do_quick)
	_apply_accent(_play_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	page.add_child(_play_btn)

	# --- таблица лидеров: серверный топ + Яндекс (только Web).
	_board_btn = _button(Lang.t("Таблица лидеров"), 16)
	_apply_accent(_board_btn, Color("1F4E79"), Color("2A6CA8"), Color("163A5C"))
	_board_btn.pressed.connect(_show_board_modal)
	page.add_child(_board_btn)

	# --- вкладки: создать комнату или войти по коду. Видна только одна
	# форма, а в начале — ни одной: список комнат при этом показывается
	# всегда. Кнопки-переключатели в группе: движок сам держит нажатое
	# состояние, тексты не меняем (иначе поплыли бы минимумы).
	_tab_group = ButtonGroup.new()
	_tab_group.allow_unpress = true
	_tabs_row = BoxContainer.new()
	_tabs_row.add_theme_constant_override("separation", 8)
	_tabs_row.alignment = BoxContainer.ALIGNMENT_CENTER
	page.add_child(_tabs_row)
	_stack_rows.append(_tabs_row)
	_tab_create_btn = _button(Lang.t("Создать комнату"), 15)
	_tab_create_btn.toggle_mode = true
	_tab_create_btn.button_group = _tab_group
	_tab_create_btn.toggled.connect(_on_rooms_tab_toggled)
	_tabs_row.add_child(_tab_create_btn)
	_tab_code_btn = _button(Lang.t("Войти по коду"), 15)
	_tab_code_btn.toggle_mode = true
	_tab_code_btn.button_group = _tab_group
	_tab_code_btn.toggled.connect(_on_rooms_tab_toggled)
	_tabs_row.add_child(_tab_code_btn)

	# --- создать (форма за вкладкой)
	_create_box = VBoxContainer.new()
	_create_box.add_theme_constant_override("separation", 8)
	_create_box.visible = false
	page.add_child(_create_box)
	_create_box.add_child(_header(Lang.t("Своя комната"), 19))
	var create_row := BoxContainer.new()
	_create_row = create_row
	create_row.add_theme_constant_override("separation", 8)
	_create_box.add_child(create_row)
	_stack_rows.append(create_row)
	# Название, пароль и выбор мест — три контрола в ряд: на телефоне в
	# узком портрете каждый из них сжимается до нечитаемой полоски, так
	# что ряд складывается в столбик (см. _stack).
	_seats_option = OptionButton.new()
	_seats_option.custom_minimum_size = Vector2(Settings.touch_w(110), Settings.touch(44))
	Settings.style_option(_seats_option, 15)
	for n in range(2, 6):
		_seats_option.add_item(Lang.t("мест: %d") % n)
		_seats_option.set_item_id(_seats_option.get_item_count() - 1, n)
	_seats_option.select(1)
	create_row.add_child(_seats_option)
	_room_name = _field(Lang.t("название (необязательно)"))
	_room_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	create_row.add_child(_room_name)
	_room_pass = _field(Lang.t("пароль (необязательно)"), true)
	_room_pass.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	create_row.add_child(_room_pass)
	_require_30 = CheckBox.new()
	# Короткая подпись обязательна: у CheckBox нет переноса, и его
	# минимальная ширина равна всей строке. На узком экране длинный
	# текст («Первый ход: минимум 30 очков») растягивал страницу
	# шире окна и уезжал за правый край вместе со всем остальным.
	_require_30.text = Lang.t("Первый ход: от 30")
	_require_30.button_pressed = Settings.require_30
	_require_30.add_theme_font_size_override("font_size", Settings.fs(15))
	_require_30.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	UiThemeClass.fit_checkbox(_require_30)
	_create_box.add_child(_require_30)
	_create_btn = _button(Lang.t("Создать"), 16)
	_create_btn.pressed.connect(_do_create)
	_apply_accent(_create_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	_create_box.add_child(_create_btn)

	# --- по коду (форма за вкладкой): коробка стоит сразу за созданием,
	# чтобы форма открывалась под своей вкладкой, а не в самом низу.
	_code_box = VBoxContainer.new()
	_code_box.add_theme_constant_override("separation", 8)
	_code_box.visible = false
	page.add_child(_code_box)
	_code_box.add_child(_header(Lang.t("Войти по коду"), 15))
	var code_row := BoxContainer.new()
	code_row.add_theme_constant_override("separation", 8)
	_code_box.add_child(code_row)
	_stack_rows.append(code_row)
	_join_code = _field(Lang.t("код"))
	_join_code.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	code_row.add_child(_join_code)
	_join_pass = _field(Lang.t("пароль"), true)
	_join_pass.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	code_row.add_child(_join_pass)
	_join_btn = _button(Lang.t("Войти"), 15)
	_join_btn.pressed.connect(func(): _do_join(
		_join_code.text.strip_edges().to_upper(), "", _join_pass.text))
	_code_box.add_child(_join_btn)

	# --- список
	page.add_child(_header(Lang.t("Все комнаты"), 19))
	var head := BoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	page.add_child(head)
	_stack_rows.append(head)
	_rooms_note = Label.new()
	_rooms_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# Тексты сюда длинные («Показаны комнаты без …, остальные серверы не
	# ответили»), и без переноса они просто уезжают за край строки.
	_rooms_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_rooms_note.add_theme_font_size_override("font_size", Settings.fs(15))
	head.add_child(_rooms_note)
	_refresh_btn = _button(Lang.t("Обновить"), 15)
	_refresh_btn.custom_minimum_size = Vector2(Settings.touch_w(120), Settings.touch(40))
	_refresh_btn.pressed.connect(_refresh_rooms)
	head.add_child(_refresh_btn)

	_rooms_box = VBoxContainer.new()
	_rooms_box.add_theme_constant_override("separation", 4)
	# Список комнат — то, ради чего эта страница: он получает высоту
	# первым, остальное на странице — обвязка. Раньше минимум стоял
	# 140, а «пояснение про случайный сервер» занимал ещё строку, и на
	# телефоне в портрете список уезжал за нижний край экрана.
	_rooms_box.custom_minimum_size = Vector2(0, 190)
	_rooms_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	page.add_child(_rooms_box)

	# --- пагинация списка: видна, только если страниц больше одной.
	_page_row = BoxContainer.new()
	_page_row.add_theme_constant_override("separation", 8)
	_page_row.alignment = BoxContainer.ALIGNMENT_CENTER
	page.add_child(_page_row)
	_stack_rows.append(_page_row)
	_page_prev = _button(Lang.t("‹"), 16)
	_page_prev.pressed.connect(_page_step.bind(-1))
	_page_row.add_child(_page_prev)
	_page_label = Label.new()
	_page_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_page_label.add_theme_font_size_override("font_size", Settings.fs(15))
	_page_label.add_theme_color_override("font_color", Color(1, 1, 1, 0.7))
	_page_row.add_child(_page_label)
	_page_next = _button(Lang.t("›"), 16)
	_page_next.pressed.connect(_page_step.bind(1))
	_page_row.add_child(_page_next)
	_page_row.visible = false

	_logout_row(page)
	return page


func _logout_row(page: VBoxContainer) -> void:
	# Web: кнопки «Выйти» нет. Выйти из Yandex ID нельзя в принципе —
	# в SDK нет такого метода, авторизация живёт в браузере. А рвать
	# только нашу сессию и делать вид, что вышли (следующий клик молча
	# вернёт тот же аккаунт), — враньё игроку.
	if OS.has_feature("web"):
		return
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_END
	page.add_child(row)
	if OS.has_feature("android"):
		# Удаление аккаунта — только Android: красная кнопка рядом
		# с выходом, дальше модалка с подтверждением.
		var del := _accent_button(Lang.t("Удалить аккаунт"), 15,
			Color("B71C1C"), Color("C62828"), Color("7F0000"))
		del.custom_minimum_size.y = Settings.touch(40)
		del.size_flags_horizontal = Control.SIZE_SHRINK_END
		del.pressed.connect(_on_delete_account)
		row.add_child(del)
	var out := _button(Lang.t("Выйти"), 15)
	# Ряд не складывается (обычный HBox), и нулевой минимум кнопки
	# с clip_text давал полоску в 8 px с полностью срезанной подписью.
	out.custom_minimum_size = Vector2(
		_text_content_width(out, out.text), Settings.touch(40))
	out.size_flags_horizontal = Control.SIZE_SHRINK_END
	out.pressed.connect(_do_logout)
	row.add_child(out)


func _build_lobby() -> VBoxContainer:
	var page := VBoxContainer.new()
	# 12 между смысловыми блоками, как на остальных страницах.
	page.add_theme_constant_override("separation", 12)
	page.visible = false

	_lobby_code = _header("", 24)
	page.add_child(_lobby_code)
	_lobby_seats = Label.new()
	_lobby_seats.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# Строка длинная («Россия (ru) · свободно 3 из 5 · первый ход: от 30»),
	# без переноса она же и задавала бы ширину страницы.
	_lobby_seats.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_lobby_seats.add_theme_font_size_override("font_size", Settings.fs(15))
	_lobby_seats.add_theme_color_override("font_color", Color(1, 1, 1, 0.6))
	page.add_child(_lobby_seats)
	_lobby_players = VBoxContainer.new()
	_lobby_players.add_theme_constant_override("separation", 6)
	_lobby_players.custom_minimum_size = Vector2(0, 160)
	_lobby_players.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	page.add_child(_lobby_players)

	_auto_hint = Label.new()
	_auto_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_auto_hint.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_auto_hint.add_theme_font_size_override("font_size", Settings.fs(14))
	_auto_hint.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
	page.add_child(_auto_hint)

	_lobby_note = Label.new()
	_lobby_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_lobby_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_lobby_note.add_theme_font_size_override("font_size", Settings.fs(15))
	_lobby_note.visible = false
	page.add_child(_lobby_note)

	_start_btn = _button(Lang.t("Начать"), 18)
	_start_btn.pressed.connect(_do_start)
	_apply_accent(_start_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	page.add_child(_start_btn)

	_leave_btn = _button(Lang.t("Выйти"), 15)
	_leave_btn.pressed.connect(_do_leave_room)
	page.add_child(_leave_btn)
	return page


# =============================================================== таблица лидеров

## Страница топа: подпись «Количество побед», дальше (Web) блок Яндекс
## Игр и только потом наш общий топ со всех платформ. Источник истины —
## сервер (очки только с реальных партий); таблица Яндекса — копия для
## платформы, в неё клиент отчитывается серверным числом побед после
## партии (см. _report_win_to_yandex в игре).
## Модалка таблицы лидеров (вместо страницы — так опрятнее): серверный
## топ сеткой «место · игрок · победы» + своё место; на Web выше блок
## Яндекс-таблицы той же сеткой. Строится один раз, дальше показывается.
func _build_board_modal() -> void:
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.6)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	dim.visible = false
	dim.gui_input.connect(_on_board_backdrop)
	add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.add_child(center)
	var panel := PanelContainer.new()
	var psb := StyleBoxFlat.new()
	psb.bg_color = Color(0.13, 0.13, 0.16, 0.98)
	psb.set_corner_radius_all(10)
	psb.content_margin_left = 20.0
	psb.content_margin_right = 20.0
	psb.content_margin_top = 16.0
	psb.content_margin_bottom = 16.0
	panel.add_theme_stylebox_override("panel", psb)
	center.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	panel.add_child(box)
	var title := Label.new()
	title.text = Lang.t("Таблица лидеров")
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(20))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)
	var note := Label.new()
	note.text = Lang.t("Количество побед")
	note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	note.add_theme_font_size_override("font_size", Settings.fs(13))
	note.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	box.add_child(note)
	# На Web таблица Яндекс Игр — ВЫШЕ нашей: она про текущий заход
	# игрока, а наша — общий топ со всех платформ (там же сидят игроки
	# с Android и других мест). На Android яндекс-блок и пометка скрыты —
	# там меняется только подпись выше.
	_ya_board_wrap = VBoxContainer.new()
	_ya_board_wrap.add_theme_constant_override("separation", 8)
	_ya_board_wrap.visible = OS.has_feature("web")
	box.add_child(_ya_board_wrap)
	var ya_title := Label.new()
	ya_title.text = Lang.t("Яндекс Игры")
	ya_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	ya_title.add_theme_font_size_override("font_size", Settings.fs(17))
	ya_title.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	_ya_board_wrap.add_child(ya_title)
	_ya_board_grid = GridContainer.new()
	_ya_board_grid.columns = 3
	_ya_board_grid.add_theme_constant_override("h_separation", 12)
	_ya_board_grid.add_theme_constant_override("v_separation", 4)
	_ya_board_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_ya_board_wrap.add_child(_ya_board_grid)
	_ya_board_note = Label.new()
	_ya_board_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_ya_board_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_ya_board_note.add_theme_font_size_override("font_size", Settings.fs(14))
	_ya_board_note.add_theme_color_override("font_color", Color(1, 1, 1, 0.6))
	_ya_board_wrap.add_child(_ya_board_note)
	# Разделитель между таблицами: два топа подряд сливались в одну
	# простыню текста. Линия + отступы вокруг (свои 10 даёт бокс).
	var sep := HSeparator.new()
	var sepline := StyleBoxLine.new()
	sepline.color = Color(1, 1, 1, 0.22)
	sepline.thickness = 1
	sep.add_theme_stylebox_override("separator", sepline)
	sep.visible = OS.has_feature("web")
	box.add_child(sep)
	var global_note := Label.new()
	global_note.text = Lang.t("Общий топ со всех платформ")
	global_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	global_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	global_note.add_theme_font_size_override("font_size", Settings.fs(13))
	global_note.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	global_note.visible = OS.has_feature("web")
	box.add_child(global_note)
	_board_grid = GridContainer.new()
	_board_grid.columns = 3
	_board_grid.add_theme_constant_override("h_separation", 12)
	_board_grid.add_theme_constant_override("v_separation", 4)
	_board_grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	box.add_child(_board_grid)
	_board_me = Label.new()
	_board_me.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_board_me.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_board_me.add_theme_font_size_override("font_size", Settings.fs(15))
	_board_me.add_theme_color_override("font_color", Color("90CAF9"))
	box.add_child(_board_me)
	_board_note = Label.new()
	_board_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_board_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_board_note.add_theme_font_size_override("font_size", Settings.fs(14))
	_board_note.visible = false
	box.add_child(_board_note)
	var close_btn := _button(Lang.t("Закрыть"), 16)
	close_btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	close_btn.pressed.connect(_hide_board_modal)
	box.add_child(close_btn)
	_board_close_btn = close_btn
	_board_modal = dim
	_board_panel = panel


func _show_board_modal() -> void:
	if _board_modal == null:
		_build_board_modal()
	var vw := get_viewport_rect().size.x
	(_board_panel as PanelContainer).custom_minimum_size = Vector2(minf(480.0, vw - 32.0), 0)
	(_board_modal as ColorRect).visible = true
	await _load_board()


func _hide_board_modal() -> void:
	if _board_modal != null:
		(_board_modal as ColorRect).visible = false


func _on_board_backdrop(event: InputEvent) -> void:
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		_hide_board_modal()
		(_board_modal as ColorRect).accept_event()


func _load_board() -> void:
	_clear_board_grid()
	_set_board_note(Lang.t("Загружаем таблицу…"), false)
	_board_me.text = ""
	_clear_ya_grid()
	var res := await Net.board_list()
	if not is_instance_valid(self) or not visible or not _board_modal.visible:
		return
	if String(res.get("t", "")) != NetProtocol.BOARD_LIST_S2C:
		_set_board_note(_reason(res, Lang.t("Не удалось загрузить таблицу")), true)
		return
	_set_board_note("", false)
	_render_board(res.get("entries", []), res.get("me", null))
	await _load_ya_board()


## Строка сетки «место · игрок · победы». Места 1–3 — цветом медали,
## своя строка — синим. Чистая отрисовка по данным, удобно тестировать.
func _render_board(entries: Array, me) -> void:
	if _board_grid == null:
		_build_board_modal()
	_clear_board_grid()
	var my_nick := ""
	if me is Dictionary:
		my_nick = String((me as Dictionary).get("nick", ""))
	var i := 0
	for e in entries:
		if not (e is Dictionary):
			continue
		i += 1
		var d := e as Dictionary
		_board_row(_board_grid, i, String(d.get("nick", "?")),
			maxi(0, int(d.get("wins", 0))),
			String(d.get("nick", "")) == my_nick and not my_nick.is_empty())
	if i == 0:
		_set_board_note(Lang.t("Нет сыгранных партий"), false)
	if me is Dictionary and not my_nick.is_empty():
		var m := me as Dictionary
		_board_me.text = Lang.t("Ваше место: %d · побед %d · партий %d") % [
			maxi(1, int(m.get("rank", 1))), maxi(0, int(m.get("wins", 0))),
			maxi(0, int(m.get("games", 0)))]
	else:
		_board_me.text = Lang.t("Сыграйте партию, чтобы попасть в топ")


## Одна строка таблицы. Сетка сама ровняет колонки по самой широкой.
func _board_row(grid: GridContainer, rank: int, nick: String, wins: int,
		mine: bool) -> void:
	var place := Label.new()
	place.text = "%d." % rank
	place.add_theme_font_size_override("font_size", Settings.fs(15))
	place.add_theme_color_override("font_color", _rank_color(rank, mine))
	grid.add_child(place)
	var who := Label.new()
	who.text = nick
	who.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	who.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	who.add_theme_font_size_override("font_size", Settings.fs(15))
	who.add_theme_color_override("font_color",
		Color("90CAF9") if mine else Color(1, 1, 1, 0.9))
	grid.add_child(who)
	var score := Label.new()
	score.text = str(wins)
	score.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	score.add_theme_font_size_override("font_size", Settings.fs(15))
	score.add_theme_color_override("font_color",
		Color("90CAF9") if mine else Color(1, 1, 1, 0.9))
	grid.add_child(score)


func _rank_color(rank: int, mine: bool) -> Color:
	if mine:
		return Color("90CAF9")
	if rank == 1:
		return Color("FFD54F")
	if rank == 2:
		return Color("C0C0C0")
	if rank == 3:
		return Color("CD7F32")
	return Color(1, 1, 1, 0.55)


func _clear_board_grid() -> void:
	for child in _board_grid.get_children():
		_board_grid.remove_child(child)
		child.free()


func _set_board_note(text: String, warn: bool) -> void:
	_board_note.text = text
	_board_note.visible = not text.is_empty()
	_board_note.add_theme_color_override("font_color",
		Color("FF8A80") if warn else Color(1, 1, 1, 0.6))


## Блок Яндекс-таблицы: читаем SDK-записи и показываем рядом с нашими.
## Нет SDK/таблицы — честная строка вместо чисел, игра не падает.
func _load_ya_board() -> void:
	if _ya_board_wrap == null or not (_ya_board_wrap as Control).visible:
		return
	_set_ya_note(Lang.t("Загружаем таблицу…"), false)
	_clear_ya_grid()
	_ysdk_call("request_lb_entries")
	if not await _ysdk_wait("lb", 20):
		_set_ya_note(Lang.t("Не удалось загрузить таблицу Яндекса"), true)
		return
	var st := _ysdk_poll("lb")
	var data = st.get("data", null)
	if not (data is Dictionary):
		_set_ya_note(_lb_reason(st), true)
		return
	var entries: Array = (data as Dictionary).get("entries", [])
	if entries.is_empty():
		_set_ya_note(Lang.t("Нет сыгранных партий"), false)
		return
	_set_ya_note("", false)
	var i := 0
	for e in entries:
		if not (e is Dictionary):
			continue
		i += 1
		var d := e as Dictionary
		var r := maxi(0, int(d.get("rank", 0)))
		_board_row(_ya_board_grid, r if r > 0 else i,
			String(d.get("name", "?")), maxi(0, int(d.get("score", 0))), false)
	var rank := maxi(0, int((data as Dictionary).get("userRank", 0)))
	if rank > 0:
		_set_ya_note(Lang.t("Ваше место в Яндексе: %d") % rank, false)


func _clear_ya_grid() -> void:
	for child in _ya_board_grid.get_children():
		_ya_board_grid.remove_child(child)
		child.free()


func _set_ya_note(text: String, warn: bool) -> void:
	_ya_board_note.text = text
	_ya_board_note.visible = not text.is_empty()
	_ya_board_note.add_theme_color_override("font_color",
		Color("FF8A80") if warn else Color(1, 1, 1, 0.6))


func _lb_reason(st: Dictionary) -> String:
	var err := String(st.get("error", ""))
	if err.is_empty() or err == "nosdk":
		return Lang.t("Не удалось загрузить таблицу Яндекса")
	return Lang.t("Не удалось загрузить таблицу Яндекса") + ": " + err


# =============================================================== удаление аккаунта

## Кнопка «Удалить аккаунт» (только Android, рядом с «Выйти»).
## Из партии/комнаты удаляться нельзя: место держится за игроком и
## партия встала бы навсегда — сначала выйти, потом удалять.
func _on_delete_account() -> void:
	if not _current_room.is_empty() or not Net.pending_room().is_empty():
		_set_note(_rooms_note, Lang.t("Сначала покиньте комнату"), true)
		return
	_show_confirm(Lang.t("Удалить аккаунт"),
		Lang.t("Удалятся ник, статистика и все данные. Вернуть их будет нельзя."),
		Lang.t("Удалить"), _do_delete_account, Lang.t("Отмена"))


## Подтверждённое удаление: сервер гасит сессии и ставит tombstone,
## клиент чистится как при выходе. Успех — окно «удалено» и уход
## в главное меню; отказ — красная строка на странице комнат.
func _do_delete_account() -> void:
	_set_note(_rooms_note, Lang.t("Удаляем аккаунт…"), false)
	var res := await Net.delete_account()
	if not is_instance_valid(self) or not visible:
		return
	if String(res.get("t", "")) != NetProtocol.ACCOUNT_DELETED:
		_set_note(_rooms_note, _reason(res, Lang.t("Не удалось удалить аккаунт")), true)
		return
	_show_confirm(Lang.t("Аккаунт и все данные удалены"), "",
		Lang.t("Понятно"), _close_after_delete, "")


func _close_after_delete() -> void:
	close()


## Общая модалка-подтверждение лобби (удаление; окно «удалено» — тот же
## каркас без отмены). Своя: модалка game.gd живёт в сцене игры.
func _show_confirm(title: String, text: String, ok_text: String,
		action: Callable, cancel_text: String) -> void:
	if _del_modal == null:
		_build_confirm()
	_del_title.text = title
	_del_text.text = text
	_del_text.visible = not text.is_empty()
	_del_ok.text = ok_text
	_del_action = action
	_del_cancel.visible = not cancel_text.is_empty()
	if not cancel_text.is_empty():
		_del_cancel.text = cancel_text
	_del_modal.visible = true


func _build_confirm() -> void:
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.6)
	dim.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	dim.visible = false
	dim.gui_input.connect(_on_confirm_backdrop)
	add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	dim.add_child(center)
	var panel := PanelContainer.new()
	var psb := StyleBoxFlat.new()
	psb.bg_color = Color(0.13, 0.13, 0.16, 0.98)
	psb.set_corner_radius_all(10)
	psb.content_margin_left = 20.0
	psb.content_margin_right = 20.0
	psb.content_margin_top = 16.0
	psb.content_margin_bottom = 16.0
	panel.add_theme_stylebox_override("panel", psb)
	center.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	panel.add_child(box)
	_del_title = Label.new()
	_del_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_del_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_del_title.add_theme_font_size_override("font_size", Settings.fs(20))
	_del_title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(_del_title)
	_del_text = Label.new()
	_del_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_del_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_del_text.add_theme_font_size_override("font_size", Settings.fs(15))
	_del_text.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	box.add_child(_del_text)
	_del_ok = _button(Lang.t("Удалить"), 16)
	_del_ok.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_apply_accent(_del_ok, Color("B71C1C"), Color("C62828"), Color("7F0000"))
	_del_ok.pressed.connect(_on_confirm_ok)
	box.add_child(_del_ok)
	_del_cancel = _button(Lang.t("Отмена"), 16)
	_del_cancel.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_del_cancel.pressed.connect(_on_confirm_no)
	box.add_child(_del_cancel)
	_del_modal = dim
	_fit_confirm_panel(panel)


## Ширина панели — по вьюпорту, как у модалки пользы: иначе текст
## кнопок срезается на узком экране.
func _fit_confirm_panel(panel: PanelContainer) -> void:
	var vw := get_viewport_rect().size.x
	panel.custom_minimum_size = Vector2(minf(440.0, vw - 32.0), 0)


func _on_confirm_ok() -> void:
	var act := _del_action
	_hide_confirm()
	if act.is_valid():
		act.call()


func _on_confirm_no() -> void:
	_hide_confirm()


func _hide_confirm() -> void:
	if _del_modal != null:
		(_del_modal as ColorRect).visible = false
	_del_action = Callable()


func _on_confirm_backdrop(event: InputEvent) -> void:
	if event is InputEventMouseButton and (event as InputEventMouseButton).pressed:
		_on_confirm_no()
		(_del_modal as ColorRect).accept_event()


# =============================================================== общие мелочи
