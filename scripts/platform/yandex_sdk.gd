extends RefCounted

## Мост к SDK Яндекс Игр (только Web, TEST MODE: только lifecycle API,
## обычной рекламы ЯИ не подключаем). Тег <script src="/sdk.js"> кладёт
## в <head> пресет Yandex_Web (html/head_include): под dev-proxy это стаб
## прокси, в проде залитого архива — настоящий SDK (относительный путь
## рекомендован доками). ensure_sdk() уже загруженный window.YaGames НЕ
## трогает, а только init() — иначе CDN-скрипт затёр бы стаб прокси и
## init падал бы с «No parent to post message». Вне Web все вызовы тихие no-op.
## Без class_name специально: Android-сборка этот файл не содержит,
## game.gd грузит его через load() под OS.has_feature("web").

const SDK_URL := "https://yandex.ru/games/sdk/v2"

## Диагностика входа/рекламы: точки [ya-sdk]/[ya-lobby] в консоли браузера.
## В проде молчим: SDK-ошибки возвращаются через poll_* и показываются UI.
## Для локальной диагностики можно временно включить true.
const DEBUG_LOG := false


static func _bridge():
	if not OS.has_feature("web"):
		return null
	if not Engine.has_singleton("JavaScriptBridge"):
		return null
	return Engine.get_singleton("JavaScriptBridge")


static func _eval(js: String):
	var bridge = _bridge()
	if bridge == null:
		return null
	return bridge.eval(js, true)


## Чтение объекта из JS: eval отдаёт JS-объекты как opaque
## JavaScriptObject, а не Dictionary (поймано логами dev-proxy: init ok,
## а все опросы отвечали "nosdk"). Поэтому гоняем через JSON.stringify
## в строке + JSON.parse_string — получается настоящий Dictionary.
## Пусто/не-Web/битый JSON — {} (коллеры отвечают дефолтом как раньше).
static func _eval_dict(js_expr: String) -> Dictionary:
	var raw = _eval("JSON.stringify(" + js_expr + ")")
	if raw == null:
		return {}
	if raw is Dictionary:
		return raw
	var parsed = JSON.parse_string(str(raw))
	if parsed is Dictionary:
		return parsed
	return {}


## Подключить SDK (один раз) и сказать LoadingAPI.ready(), когда готов.
## Уже загруженный window.YaGames (тег из shell: стаб dev-proxy или прод)
## только init() — повторная загрузка с CDN затёрла бы его и дала
## «No parent to post message» под прокси. Rejection init ловим во флаг,
## иначе дальше всё молча отвечает nosdk и причина не видна нигде.
static func ensure_sdk() -> void:
	_eval("(function(){if(window.__ysdkRequested)return;window.__ysdkRequested=true;" \
		+ "var dbg=" + ("true" if DEBUG_LOG else "false") \
		+ ";function log(m){if(dbg)console.log(m);}" \
		+ "window.__ysdkInitError='';" \
		+ "function initNow(){try{YaGames.init().then(function(ysdk){window.__ysdk=ysdk;" \
		+ "window.__yaGameApiPaused=false;" \
		+ "if(!window.__ysdkEventsBound){window.__ysdkEventsBound=true;" \
		+ "try{ysdk.on('game_api_pause',function(){window.__yaGameApiPaused=true;});" \
		+ "ysdk.on('game_api_resume',function(){window.__yaGameApiPaused=false;});}" \
		+ "catch(e){}}" \
		+ "log('[ya-sdk] init ok');" \
		+ "try{ysdk.features.LoadingAPI.ready();}catch(e){}})" \
		+ ".catch(function(e){window.__ysdkInitError=String(e&&e.message||e);" \
		+ "log('[ya-sdk] init fail: '+window.__ysdkInitError);});}catch(e){" \
		+ "window.__ysdkInitError=String(e&&e.message||e);" \
		+ "log('[ya-sdk] init throw: '+window.__ysdkInitError);}}" \
		+ "log('[ya-sdk] ensure, YaGames present='+(!!window.YaGames));" \
		+ "if(window.YaGames){initNow();return;}" \
		+ "log('[ya-sdk] injecting /sdk.js');" \
		+ "var s=document.createElement('script');s.src='/sdk.js';" \
		+ "s.onload=function(){log('[ya-sdk] /sdk.js loaded');initNow();};" \
		+ "s.onerror=function(){log('[ya-sdk] /sdk.js failed, fallback CDN');" \
		+ "var c=document.createElement('script');" \
		+ "c.src='" + SDK_URL + "';c.onload=function(){" \
		+ "log('[ya-sdk] CDN loaded');initNow();};" \
		+ "c.onerror=function(){window.__ysdkInitError='sdk load failed';" \
		+ "log('[ya-sdk] CDN failed');};" \
		+ "document.head.appendChild(c);};" \
		+ "document.head.appendChild(s);})()")


## Готов ли SDK: {ready, error}. Вызывать после небольшой паузы —
## скрипту нужно время загрузиться.
static func poll_sdk_ready() -> Dictionary:
	var r := _eval_dict("({r:!!window.__ysdk,e:String(window.__ysdkInitError||'')})")
	if r.is_empty():
		return {"ready": false, "error": "nosdk"}
	return {"ready": bool(r.get("r", false)),
		"error": String(r.get("e", ""))}


## Язык интерфейса игрока из SDK (п. 2.14 Требований: игра обязана
## говорить на языке платформы). Синхронное свойство — доступно сразу
## после init, ждать нечего. Нет SDK / нет поля — '' (коллер оставляет
## как было). Значения вида 'ru', 'en', 'tr', 'uk', 'be', 'kk'...
static func sdk_lang() -> String:
	var raw = _eval("String((window.__ysdk&&window.__ysdk.environment" \
		+ "&&window.__ysdk.environment.i18n" \
		+ "&&window.__ysdk.environment.i18n.lang)||'')")
	if raw == null:
		return ""
	return String(raw).to_lower().strip_edges()


## События платформы game_api_pause/game_api_resume: JS-слушатели
## ставят флаг, Godot-процесс его опрашивает и глушит/возвращает звук.
static func platform_paused() -> bool:
	var raw = _eval("!!window.__yaGameApiPaused")
	return bool(raw)


## Игрок реально играет (ходить/партия началась).
static func gameplay_start() -> void:
	_eval("try{if(window.__ysdk&&window.__ysdk.features.GameplayAPI)" \
		+ "window.__ysdk.features.GameplayAPI.start();}catch(e){}")


## Игра встала (победа, выход в меню).
static func gameplay_stop() -> void:
	_eval("try{if(window.__ysdk&&window.__ysdk.features.GameplayAPI)" \
		+ "window.__ysdk.features.GameplayAPI.stop();}catch(e){}")


## Rewarded-видео за подсказку. Флаги результата — в window:
## __yaHintRewarded (награда есть), __yaHintClosed (закрыто),
## __yaHintError (ошибка/нет SDK). Строго: награды нет — подсказки нет.
static func show_hint_rewarded() -> void:
	_eval("(function(){window.__yaHintRewarded=false;window.__yaHintClosed=false;" \
		+ "window.__yaHintError='';" \
		+ "try{if(!window.__ysdk||!window.__ysdk.adv)throw 'nosdk';" \
		+ "window.__ysdk.adv.showRewardedVideo({callbacks:{" \
		+ "onRewarded:function(){window.__yaHintRewarded=true;}," \
		+ "onClose:function(){window.__yaHintClosed=true;}," \
		+ "onError:function(e){window.__yaHintError=String(e&&e.message||e);" \
		+ "window.__yaHintClosed=true;}}});}" \
		+ "catch(e){window.__yaHintError=String(e&&e.message||e);window.__yaHintClosed=true;}})()")


## Состояние rewarded за подсказку: {rewarded, closed, error}.
static func poll_hint_ad() -> Dictionary:
	var r := _eval_dict("({r:!!window.__yaHintRewarded,c:!!window.__yaHintClosed," \
		+ "e:String(window.__yaHintError||'')})")
	if r.is_empty():
		return {"rewarded": false, "closed": true, "error": "nosdk"}
	return {"rewarded": bool(r.get("r", false)),
		"closed": bool(r.get("c", false)),
		"error": String(r.get("e", ""))}


## Fullscreen после партии (после обратного отсчёта). Флаги:
## __yaEndClosed, __yaEndError. Ошибки/частые вызовы — сразу closed.
static func show_endgame_fullscreen() -> void:
	_eval("(function(){window.__yaEndClosed=false;window.__yaEndError='';" \
		+ "try{if(!window.__ysdk||!window.__ysdk.adv)throw 'nosdk';" \
		+ "window.__ysdk.adv.showFullscreenAdv({callbacks:{" \
		+ "onClose:function(){window.__yaEndClosed=true;}," \
		+ "onError:function(e){window.__yaEndError=String(e&&e.message||e);" \
		+ "window.__yaEndClosed=true;}}});}" \
		+ "catch(e){window.__yaEndError=String(e&&e.message||e);window.__yaEndClosed=true;}})()")


## Состояние post-game рекламы: {closed, error}.
static func poll_endgame_ad() -> Dictionary:
	var r := _eval_dict("({c:!!window.__yaEndClosed,e:String(window.__yaEndError||'')})")
	if r.is_empty():
		return {"closed": true, "error": "nosdk"}
	return {"closed": bool(r.get("c", false)),
		"error": String(r.get("e", ""))}


## Диалог авторизации Yandex ID — только явная кнопка с объяснением выгод
## (требование 1.2). Флаги: __yaAuthDone, __yaAuthError.
static func open_auth_dialog() -> void:
	_eval("(function(){window.__yaAuthDone=false;window.__yaAuthError='';" \
		+ "try{if(!window.__ysdk||!window.__ysdk.auth)throw 'nosdk';" \
		+ "window.__ysdk.auth.openAuthDialog().then(function(){window.__yaAuthDone=true;})" \
		+ ".catch(function(e){window.__yaAuthError=String(e&&e.message||e);" \
		+ "window.__yaAuthDone=true;});}" \
		+ "catch(e){window.__yaAuthError=String(e&&e.message||e);window.__yaAuthDone=true;}})()")


## Состояние диалога: {done, error}.
static func poll_auth_dialog() -> Dictionary:
	var r := _eval_dict("({d:!!window.__yaAuthDone,e:String(window.__yaAuthError||'')})")
	if r.is_empty():
		return {"done": true, "error": "nosdk"}
	return {"done": bool(r.get("d", false)),
		"error": String(r.get("e", ""))}


## Профиль игрока: запускает getPlayer, результат — в poll_player.
## Без диалога вернёт lite-ID гостя (играть можно, онлайн — после кнопки).
static func request_player() -> void:
	_eval("(function(){window.__yaPlayerDone=false;window.__yaPlayerData=null;" \
		+ "window.__yaPlayerError='';" \
		+ "try{if(!window.__ysdk)throw 'nosdk';" \
		+ "window.__ysdk.getPlayer().then(function(p){var d=null;" \
		+ "try{d={uid:String(p.getUniqueID()),name:'',authorized:false};" \
		+ "try{d.authorized=!!p.isAuthorized();}catch(e){}" \
		+ "try{d.name=String(p.getName()||'');}catch(e){}}" \
		+ "catch(e){}window.__yaPlayerData=d;window.__yaPlayerDone=true;})" \
		+ ".catch(function(e){window.__yaPlayerError=String(e&&e.message||e);" \
		+ "window.__yaPlayerDone=true;});}" \
		+ "catch(e){window.__yaPlayerError=String(e&&e.message||e);window.__yaPlayerDone=true;}})()")


## Состояние профиля: {done, data ({uid, name, authorized} или null), error}.
static func poll_player() -> Dictionary:
	var r := _eval_dict("({d:!!window.__yaPlayerDone,t:(window.__yaPlayerData||null)," \
		+ "e:String(window.__yaPlayerError||'')})")
	if r.is_empty():
		return {"done": true, "data": null, "error": "nosdk"}
	var data = r.get("t", null)
	if data != null and not (data is Dictionary):
		data = null
	return {"done": bool(r.get("d", false)),
		"data": data, "error": String(r.get("e", ""))}


## Имя лидерборда в консоли Яндекс Игр. Создаётся один раз разработчиком
## в консоли (иначе записи и чтение отвечают ошибкой — она видна в флагах
## ниже, игра не падает). Очки — число побед С НАШЕГО СЕРВЕРА: клиент
## отчитывается серверным числом, свой топ сервер считает сам.
const LB_NAME := "wins"


## Записи лидерборда: запускает чтение, результат — в poll_lb_entries.
## Новый API (getEntries) с запасным старым (getLeaderboardEntries):
## что есть в рантайме, то и едет — стаб dev-proxy логирует вызов сам.
static func request_lb_entries() -> void:
	_eval("(function(){window.__yaLbDone=false;window.__yaLbData=null;" \
		+ "window.__yaLbError='';" \
		+ "function fail(m){window.__yaLbError=String(m);window.__yaLbDone=true;}" \
		+ "try{if(!window.__ysdk)throw 'nosdk';" \
		+ "window.__ysdk.getLeaderboards().then(function(lbs){if(!lbs)throw 'no-lb';" \
		+ "if(lbs.getEntries)return lbs.getEntries('" + LB_NAME + "');" \
		+ "if(lbs.getLeaderboardEntries)return lbs.getLeaderboardEntries('" + LB_NAME + "');" \
		+ "throw 'no-entries-api';}).then(function(res){var out={entries:[],userRank:0};" \
		+ "try{var list=res.entries||res.leaderboardEntries||[];" \
		+ "for(var i=0;i<list.length;i++){var e=list[i]||{};var pl=e.player||{};" \
		+ "out.entries.push({name:String(pl.publicName||'')," \
		+ "score:Number(e.score||0),rank:Number(e.rank||0)});}" \
		+ "out.userRank=Number(res.userRank||0);}catch(e){}" \
		+ "window.__yaLbData=out;window.__yaLbDone=true;})" \
		+ ".catch(function(e){fail(e&&e.message||e);});}" \
		+ "catch(e){fail(e&&e.message||e);}})()")


## Состояние чтения таблицы: {done, data ({entries, userRank} или null), error}.
static func poll_lb_entries() -> Dictionary:
	var r := _eval_dict("({d:!!window.__yaLbDone,t:(window.__yaLbData||null)," \
		+ "e:String(window.__yaLbError||'')})")
	if r.is_empty():
		return {"done": true, "data": null, "error": "nosdk"}
	var data = r.get("t", null)
	if data != null and not (data is Dictionary):
		data = null
	return {"done": bool(r.get("d", false)),
		"data": data, "error": String(r.get("e", ""))}


## Отчёт очков (число побед с сервера) в лидерборд. Только явный вызов
## после партии — никакого автоспама. Флаги: __yaLbReportDone/Error.
static func report_lb_score(score: int) -> void:
	_eval("(function(){window.__yaLbReportDone=false;window.__yaLbReportError='';" \
		+ "function fail(m){window.__yaLbReportError=String(m);" \
		+ "window.__yaLbReportDone=true;}" \
		+ "try{if(!window.__ysdk)throw 'nosdk';" \
		+ "window.__ysdk.getLeaderboards().then(function(lbs){if(!lbs)throw 'no-lb';" \
		+ "if(lbs.setScore)return lbs.setScore({leaderboardName:'" + LB_NAME + "'," \
		+ "score:" + str(score) + "});" \
		+ "if(lbs.setLeaderboardScore)return lbs.setLeaderboardScore('" + LB_NAME + "'," \
		+ str(score) + ");" \
		+ "throw 'no-setscore-api';}).then(function(){window.__yaLbReportDone=true;})" \
		+ ".catch(function(e){fail(e&&e.message||e);});}" \
		+ "catch(e){fail(e&&e.message||e);}})()")


## Состояние отчёта: {done, error}.
static func poll_lb_report() -> Dictionary:
	var r := _eval_dict("({d:!!window.__yaLbReportDone," \
		+ "e:String(window.__yaLbReportError||'')})")
	if r.is_empty():
		return {"done": true, "error": "nosdk"}
	return {"done": bool(r.get("d", false)), "error": String(r.get("e", ""))}


## Облачное сохранение настроек и статистики (данные игрока): ключи
## 'settings' и 'stats'. У авторизованного — облако аккаунта (живёт на
## всех устройствах), у гостя — хранилище браузера: так SDK разделяет
## данные сам. Флаги: __yaCloudLoadDone/Data/Error.
static func request_cloud_load() -> void:
	_eval("(function(){window.__yaCloudLoadDone=false;window.__yaCloudLoadData=null;" \
		+ "window.__yaCloudLoadError='';" \
		+ "function fail(m){window.__yaCloudLoadError=String(m);window.__yaCloudLoadDone=true;}" \
		+ "try{if(!window.__ysdk)throw 'nosdk';" \
		+ "window.__ysdk.getPlayer().then(function(p){return p.getData(['settings','stats']);})" \
		+ ".then(function(d){window.__yaCloudLoadData=d||null;window.__yaCloudLoadDone=true;})" \
		+ ".catch(function(e){fail(e&&e.message||e);});}" \
		+ "catch(e){fail(e);}})()")


## Состояние загрузки: {done, data (Dictionary или null), error}.
static func poll_cloud_load() -> Dictionary:
	var r := _eval_dict("({d:!!window.__yaCloudLoadDone," \
		+ "t:(window.__yaCloudLoadData||null)," \
		+ "e:String(window.__yaCloudLoadError||'')})")
	if r.is_empty():
		return {"done": true, "data": null, "error": "nosdk"}
	var data = r.get("t", null)
	if data != null and not (data is Dictionary):
		data = null
	return {"done": bool(r.get("d", false)),
		"data": data, "error": String(r.get("e", ""))}


## Запись блоба (JSON-строка) в данные игрока. flush=true — немедленная
## запись (финал партии, уход страницы в фон), иначе SDK положит сам.
## Флаги: __yaCloudSaveDone/Error.
static func request_cloud_save(payload_json: String, flush: bool) -> void:
	_eval("(function(){window.__yaCloudSaveDone=false;window.__yaCloudSaveError='';" \
		+ "function fail(m){window.__yaCloudSaveError=String(m);window.__yaCloudSaveDone=true;}" \
		+ "try{if(!window.__ysdk)throw 'nosdk';" \
		+ "var blob=null;" \
		+ "try{blob=JSON.parse(" + JSON.stringify(payload_json) + ");}catch(e){fail('bad-json');return;}" \
		+ "window.__ysdk.getPlayer().then(function(p){return p.setData(blob," \
		+ ("true" if flush else "false") + ");})" \
		+ ".then(function(){window.__yaCloudSaveDone=true;})" \
		+ ".catch(function(e){fail(e&&e.message||e);});}" \
		+ "catch(e){fail(e);}})()")


## Состояние записи: {done, error}.
static func poll_cloud_save() -> Dictionary:
	var r := _eval_dict("({d:!!window.__yaCloudSaveDone," \
		+ "e:String(window.__yaCloudSaveError||'')})")
	if r.is_empty():
		return {"done": true, "error": "nosdk"}
	return {"done": bool(r.get("d", false)), "error": String(r.get("e", ""))}
