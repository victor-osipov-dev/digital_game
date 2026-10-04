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


## Подключить SDK (один раз) и сказать LoadingAPI.ready(), когда готов.
## Уже загруженный window.YaGames (тег из shell: стаб dev-proxy или прод)
## только init() — повторная загрузка с CDN затёрла бы его и дала
## «No parent to post message» под прокси. Rejection init ловим во флаг,
## иначе дальше всё молча отвечает nosdk и причина не видна нигде.
static func ensure_sdk() -> void:
	_eval("(function(){if(window.__ysdkRequested)return;window.__ysdkRequested=true;" \
		+ "window.__ysdkInitError='';" \
		+ "function initNow(){try{YaGames.init().then(function(ysdk){window.__ysdk=ysdk;" \
		+ "try{ysdk.features.LoadingAPI.ready();}catch(e){}})" \
		+ ".catch(function(e){window.__ysdkInitError=String(e&&e.message||e);});}catch(e){" \
		+ "window.__ysdkInitError=String(e&&e.message||e);}}" \
		+ "if(window.YaGames){initNow();return;}" \
		+ "var s=document.createElement('script');s.src='/sdk.js';s.onload=initNow;" \
		+ "s.onerror=function(){var c=document.createElement('script');" \
		+ "c.src='" + SDK_URL + "';c.onload=initNow;" \
		+ "c.onerror=function(){window.__ysdkInitError='sdk load failed'};" \
		+ "document.head.appendChild(c);};" \
		+ "document.head.appendChild(s);})()")


## Готов ли SDK: {ready, error}. Вызывать после небольшой паузы —
## скрипту нужно время загрузиться.
static func poll_sdk_ready() -> Dictionary:
	var r = _eval("({r:!!window.__ysdk,e:String(window.__ysdkInitError||'')})")
	if r == null or not (r is Dictionary):
		return {"ready": false, "error": "nosdk"}
	return {"ready": bool((r as Dictionary).get("r", false)),
		"error": String((r as Dictionary).get("e", ""))}


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
	var r = _eval("({r:!!window.__yaHintRewarded,c:!!window.__yaHintClosed," \
		+ "e:String(window.__yaHintError||'')})")
	if r == null or not (r is Dictionary):
		return {"rewarded": false, "closed": true, "error": "nosdk"}
	return {"rewarded": bool((r as Dictionary).get("r", false)),
		"closed": bool((r as Dictionary).get("c", false)),
		"error": String((r as Dictionary).get("e", ""))}


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
	var r = _eval("({c:!!window.__yaEndClosed,e:String(window.__yaEndError||'')})")
	if r == null or not (r is Dictionary):
		return {"closed": true, "error": "nosdk"}
	return {"closed": bool((r as Dictionary).get("c", false)),
		"error": String((r as Dictionary).get("e", ""))}


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
	var r = _eval("({d:!!window.__yaAuthDone,e:String(window.__yaAuthError||'')})")
	if r == null or not (r is Dictionary):
		return {"done": true, "error": "nosdk"}
	return {"done": bool((r as Dictionary).get("d", false)),
		"error": String((r as Dictionary).get("e", ""))}


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
	var r = _eval("({d:!!window.__yaPlayerDone,t:(window.__yaPlayerData||null)," \
		+ "e:String(window.__yaPlayerError||'')})")
	if r == null or not (r is Dictionary):
		return {"done": true, "data": null, "error": "nosdk"}
	var data = (r as Dictionary).get("t", null)
	if data != null and not (data is Dictionary):
		data = null
	return {"done": bool((r as Dictionary).get("d", false)),
		"data": data, "error": String((r as Dictionary).get("e", ""))}
