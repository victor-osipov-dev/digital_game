extends RefCounted

## Мост к нативному Android-плагину MarketHelper (синглтон движка).
## Без class_name специально: Web-сборка этот файл не содержит, и game.gd
## грузит его через load() под OS.has_feature("android"). Вне Android
## синглтона нет — все методы честно отвечают «недоступно», и game.gd
## ни одну из этих веток не вызывает (карточка строится только на Android).
const Lang := preload("res://scripts/core/lang.gd")

## Пакет Яндекс Маркета для точечной проверки. НЕ вечный идентификатор —
## перед релизом сверить на устройстве.
const MARKET_PACKAGE := "ru.beru.android"


static func _plugin():
	if Engine.has_singleton("MarketHelper"):
		return Engine.get_singleton("MarketHelper")
	return null


## Заряд 0..100, <0 — неизвестен (тогда настолки, как требует план).
static func battery_percent() -> int:
	var p = _plugin()
	if p == null:
		return -1
	var v := int(p.call("getBatteryPercent"))
	if v < 0 or v > 100:
		return -1
	return v


## Установлен ли именно Яндекс Маркет (списки приложений не собираем).
static func is_market_installed() -> bool:
	var p = _plugin()
	if p == null:
		return false
	return bool(p.call("isMarketInstalled"))


## Открыть ссылку: Маркет → браузер → false. Никаких авто-действий:
## вызывается только из нажатия кнопки карточки.
static func open_partner_link(url: String) -> bool:
	if String(url).is_empty():
		return false
	var p = _plugin()
	if p != null:
		return bool(p.call("openMarketLink", String(url)))
	return OS.shell_open(String(url)) == OK
