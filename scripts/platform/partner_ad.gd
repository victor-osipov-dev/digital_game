extends RefCounted

## Партнёрская реклама Яндекс Маркета — ТОЛЬКО Android/RuStore.
## TEST MODE: готовые ссылки для технической проверки, начислений нет.
## URL не менять, параметры не добавлять, сокращалками не сокращать.
## Без class_name специально: Web-сборка этот файл не содержит, и game.gd
## грузит его через load() под OS.has_feature("android").
const Lang := preload("res://scripts/core/lang.gd")

## Тестовые ссылки (план, TEST MODE).
const POWERBANK_URL := "https://market.yandex.ru/cc/BE2LYU"
const BOARD_GAMES_URL := "https://market.yandex.ru/cc/BE2NBZ"
## Заряд ниже — приоритет Power Bank.
const LOW_BATTERY_THRESHOLD := 20


## Что показать: {kind, url, title, text}. battery < 0 (неизвестен) —
## настолки (так требует план).
static func pick(battery_percent: int) -> Dictionary:
	if battery_percent >= 0 and battery_percent < LOW_BATTERY_THRESHOLD:
		return {
			"kind": "powerbank",
			"url": POWERBANK_URL,
			"title": Lang.t("Может пригодиться Power Bank"),
			"text": Lang.t("Подборка на Яндекс Маркете"),
		}
	return {
		"kind": "board_games",
		"url": BOARD_GAMES_URL,
		"title": Lang.t("Подборка настольных игр"),
		"text": Lang.t("На Яндекс Маркете"),
	}


## Можно ли показать: только Android и только финальный экран.
## Платформу и состояние передаём параметрами, чтобы логика тестировалась
## без устройства.
static func can_show(is_android: bool, finished: bool) -> bool:
	return is_android and finished


## Картинка креатива (локальный ассет, работает офлайн до клика).
static func image_path(kind: String) -> String:
	if String(kind) == "powerbank":
		return "res://assets/ads/powerbank.webp"
	return "res://assets/ads/board_games.webp"
