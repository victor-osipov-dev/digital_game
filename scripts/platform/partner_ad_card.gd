extends PanelContainer

## Карточка партнёрской рекламы (экран результата, только Android).
## Отдельный визуальный блок — не игровой элемент: тёмный фон, янтарная
## рамка, обязательная пометка «Реклама». Без class_name специально:
## Web-сборка этот файл не содержит, game.gd грузит его через load().

## Наружу: game.gd открывает ссылку через MarketHelper (Маркет/браузер).
signal open_requested(url: String)

const Lang := preload("res://scripts/core/lang.gd")

## Защита от двойного тапа: второй Intent за секунду не уходит.
const TAP_GAP_MS := 1000

var _url := ""
## Давно в прошлом: первый тап никогда не гасится (иначе в первые секунды
## жизни процесса честное нажатие съедалось бы дебаунсом).
var _last_tap_ms := -10000


## Строит содержимое по словарю PartnerAd.pick(). Вызывать один раз.
func setup(ad: Dictionary) -> void:
	_url = String(ad.get("url", ""))
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color("1C2530")
	sb.border_color = Color("E8A33D")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(12)
	sb.content_margin_left = 14.0
	sb.content_margin_right = 14.0
	sb.content_margin_top = 10.0
	sb.content_margin_bottom = 12.0
	add_theme_stylebox_override("panel", sb)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	add_child(box)
	var ad_label := Label.new()
	ad_label.text = Lang.t("Реклама")
	ad_label.add_theme_font_size_override("font_size", Settings.fs(13))
	ad_label.add_theme_color_override("font_color", Color("E8A33D"))
	box.add_child(ad_label)
	var img_path := String(ad.get("image", ""))
	if not img_path.is_empty() and ResourceLoader.exists(img_path):
		var img := TextureRect.new()
		img.texture = load(img_path) as Texture2D
		img.expand_mode = TextureRect.EXPAND_FIT_WIDTH
		img.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		img.custom_minimum_size = Vector2(0, 140)
		img.mouse_filter = Control.MOUSE_FILTER_IGNORE
		box.add_child(img)
	var title := Label.new()
	title.text = String(ad.get("title", ""))
	title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	title.add_theme_font_size_override("font_size", Settings.fs(20))
	title.add_theme_color_override("font_color", Color(1, 1, 1, 0.95))
	box.add_child(title)
	var text := Label.new()
	text.text = String(ad.get("text", ""))
	text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	text.add_theme_font_size_override("font_size", Settings.fs(15))
	text.add_theme_color_override("font_color", Color(1, 1, 1, 0.65))
	box.add_child(text)
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	box.add_child(row)
	var btn := Button.new()
	btn.text = Lang.t("Посмотреть")
	btn.custom_minimum_size = Vector2(Settings.touch_w(200), Settings.touch(52))
	btn.add_theme_font_size_override("font_size", Settings.fs(17))
	btn.pressed.connect(_on_open_pressed)
	row.add_child(btn)


func _on_open_pressed() -> void:
	var now := Time.get_ticks_msec()
	if now - _last_tap_ms < TAP_GAP_MS:
		return
	_last_tap_ms = now
	open_requested.emit(_url)
