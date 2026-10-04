extends SceneTree

# ==============================================================
#  Партнёрская реклама (только Android): выбор креатива, gating,
#  карточка, мост без синглтона.
#
#  Headless: чистая логика + построение карточки. Открытие ссылок и
#  сам синглтон плагина проверяются только на устройстве.
#
#     godot --headless --path . --script res://tests/test_partner_ads.gd
# ==============================================================

const AD_SCRIPT := "res://scripts/platform/partner_ad.gd"
const CARD_SCRIPT := "res://scripts/platform/partner_ad_card.gd"
const HELPER_SCRIPT := "res://scripts/platform/market_helper.gd"

var fails := 0
var total := 0
var opened := []


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	var ad = load(AD_SCRIPT)
	var card_script = load(CARD_SCRIPT)
	var helper = load(HELPER_SCRIPT)
	if ad == null or card_script == null or helper == null:
		printerr("FAIL  скрипты рекламы не грузятся")
		quit(1)
		return
	test_pick(ad)
	test_gating(ad)
	await test_card(card_script)
	test_helper(helper)
	if fails == 0:
		print("\nPARTNER ADS: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nPARTNER ADS: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)


func test_pick(ad) -> void:
	section("выбор креатива по заряду")
	var pb: Dictionary = ad.pick(0)
	ok("0% — powerbank", String(pb.get("kind", "")) == "powerbank")
	ok("ссылка powerbank дословно",
		String(pb.get("url", "")) == "https://market.yandex.ru/cc/BE2LYU")
	var pb19: Dictionary = ad.pick(19)
	ok("19% — powerbank", String(pb19.get("kind", "")) == "powerbank")
	var bg20: Dictionary = ad.pick(20)
	ok("20% — уже настолки", String(bg20.get("kind", "")) == "board_games")
	var bg50: Dictionary = ad.pick(50)
	ok("50% — настолки", String(bg50.get("kind", "")) == "board_games")
	ok("ссылка настолок дословно",
		String(bg50.get("url", "")) == "https://market.yandex.ru/cc/BE2NBZ")
	var bg100: Dictionary = ad.pick(100)
	ok("100% — настолки", String(bg100.get("kind", "")) == "board_games")
	var unk: Dictionary = ad.pick(-1)
	ok("неизвестный заряд — настолки", String(unk.get("kind", "")) == "board_games")
	ok("путь картинки powerbank",
		String(ad.image_path("powerbank")) == "res://assets/ads/powerbank.webp")
	ok("путь картинки настолок",
		String(ad.image_path("board_games")) == "res://assets/ads/board_games.webp")
	ok("неизвестный kind — настолки",
		String(ad.image_path("???")) == "res://assets/ads/board_games.webp")
	ok("ассет powerbank на месте",
		FileAccess.file_exists("res://assets/ads/powerbank.webp"))
	ok("ассет настолок на месте",
		FileAccess.file_exists("res://assets/ads/board_games.webp"))


func test_gating(ad) -> void:
	section("показ только на финальном экране Android")
	ok("android+финал — можно", bool(ad.can_show(true, true)))
	ok("web+финал — нельзя", not bool(ad.can_show(false, true)))
	ok("android+игра — нельзя", not bool(ad.can_show(true, false)))
	ok("всё выключено — нельзя", not bool(ad.can_show(false, false)))
	ok("релиз без рекламы (флаг)", not bool(ad.ENABLED))


func test_card(card_script) -> void:
	section("карточка: структура и один переход")
	var ad: Dictionary = {"kind": "board_games", "url": "https://example.invalid/x",
		"title": "T", "text": "D", "image": "res://nonexistent.webp"}
	var card = card_script.new()
	root.add_child(card)
	card.setup(ad)
	var btn := _find_button(card, "Посмотреть")
	ok("кнопка перехода есть", btn != null)
	ok("пометка «Реклама» есть", _find_label(card, "Реклама") != null)
	if btn == null:
		card.queue_free()
		return
	card.open_requested.connect(func(url): opened.append(String(url)))
	btn.pressed.emit()
	await process_frame
	btn.pressed.emit()
	await process_frame
	ok("двойной тап — один переход", opened == ["https://example.invalid/x"], str(opened))
	card.queue_free()


func test_helper(helper) -> void:
	section("мост без синглтона честно недоступен")
	ok("батареи нет", int(helper.battery_percent()) == -1)
	ok("маркета нет", not bool(helper.is_market_installed()))


func _find_button(node: Node, text: String) -> Button:
	if node is Button and String((node as Button).text) == text:
		return node as Button
	for child in node.get_children():
		var found := _find_button(child, text)
		if found != null:
			return found
	return null


func _find_label(node: Node, text: String) -> Label:
	if node is Label and String((node as Label).text) == text:
		return node as Label
	for child in node.get_children():
		var found := _find_label(child, text)
		if found != null:
			return found
	return null


func section(name: String) -> void:
	print("\n== %s ==" % name)


func ok(msg: String, cond: bool, detail: String = "") -> void:
	total += 1
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		var line := "FAIL  " + msg
		if not detail.is_empty():
			line += " | " + detail
		printerr(line)
