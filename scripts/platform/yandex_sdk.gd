extends RefCounted

## Мост к SDK Яндекс Игр (только Web, TEST MODE: только lifecycle API,
## обычной рекламы ЯИ не подключаем). SDK подгружается динамически
## скрипт-тегом — без кастомного shell. Вне Web все вызовы тихие no-op.
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
static func ensure_sdk() -> void:
	_eval("(function(){if(window.__ysdkRequested)return;window.__ysdkRequested=true;" \
		+ "var s=document.createElement('script');s.src='" + SDK_URL + "';" \
		+ "s.onload=function(){try{YaGames.init().then(function(ysdk){window.__ysdk=ysdk;" \
		+ "try{ysdk.features.LoadingAPI.ready();}catch(e){}});}catch(e){}};" \
		+ "document.head.appendChild(s);})()")


## Игрок реально играет (ходить/партия началась).
static func gameplay_start() -> void:
	_eval("try{if(window.__ysdk&&window.__ysdk.features.GameplayAPI)" \
		+ "window.__ysdk.features.GameplayAPI.start();}catch(e){}")


## Игра встала (победа, выход в меню).
static func gameplay_stop() -> void:
	_eval("try{if(window.__ysdk&&window.__ysdk.features.GameplayAPI)" \
		+ "window.__ysdk.features.GameplayAPI.stop();}catch(e){}")
