extends RefCounted

# Единый вид кнопок: одно скругление везде. Цвета и шрифты тема не
# трогает (у акцентных кнопок свои), только форму: клонируем дефолтные
# стильбоксы движка и правим в них исключительно радиус. Поэтому любая
# кнопка без явного оверрайда выглядит так же, как с ним.
#
# Без class_name специально: файл новый, а глобальные имена берутся из
# кэша редактора (см. комментарий про preload в main_menu.gd). Все три
# сцены подключают через preload-константу UiThemeClass.
const CORNER := 10
## Размер рисованных иконок чекбокса: минимум поля считается по нему же.
const CHECK_SIZE := 18

static var _theme: Theme = null


static func shared() -> Theme:
	if _theme != null:
		return _theme
	_theme = Theme.new()
	# Дефолты берём с живого зонда, а не из ThemeDB: так тема строится
	# на любом движке и точно повторяет его цвета и поля.
	var probe := Button.new()
	var probe_opt := OptionButton.new()
	for cls in ["Button", "OptionButton"]:
		var sample: Control = probe if cls == "Button" else probe_opt
		for state in ["normal", "hover", "pressed", "disabled", "focus"]:
			var src := sample.get_theme_stylebox(state)
			# Клонируем только плоские: пустые (focus) и прочие особые
			# стили оставляем дефолтными, иначе кнопка потеряла бы фон.
			if src is StyleBoxFlat:
				var sb := (src as StyleBoxFlat).duplicate() as StyleBoxFlat
				sb.set_corner_radius_all(CORNER)
				_theme.set_stylebox(state, cls, sb)
	probe.free()
	probe_opt.free()
	# Чекбокс НЕ должен наследовать фоны кнопок: по иерархии типов
	# CheckBox тянет стильбоксы Button, и включённый чекбокс рисовал
	# себе под строкой чёрный фон (pressed-стиль кнопки). Возвращаем
	# прозрачность — как было без темы. Фокус не трогаем: белая рамка
	# нужна тем, кто ходит с клавиатуры/геймпада.
	for state in ["normal", "hover", "pressed", "disabled"]:
		_theme.set_stylebox(state, "CheckBox", StyleBoxEmpty.new())
	# Свои галки чекбоксов: дефолтные на тёмной теме нечитаемы —
	# пустой квадрат там буквально чёрный, а галка без рамки
	# растворяется в фоне. Рисуем светлую рамку и зелёную галку.
	_theme.set_icon("checked", "CheckBox", _checkbox_icon(true, false))
	_theme.set_icon("unchecked", "CheckBox", _checkbox_icon(false, false))
	_theme.set_icon("checked_disabled", "CheckBox", _checkbox_icon(true, true))
	_theme.set_icon("unchecked_disabled", "CheckBox", _checkbox_icon(false, true))
	return _theme


## Иконка чекбокса 18 px: скруглённая рамка + зелёная галка.
## Рисуем попиксельно — везти PNG ради двух иконок незачем.
static func _checkbox_icon(check: bool, dim: bool) -> ImageTexture:
	var s := CHECK_SIZE
	var img := Image.create(s, s, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var edge := Color(1, 1, 1, 0.35 if dim else 0.9)
	var mark := Color(0.4, 0.73, 0.42, 0.35 if dim else 1.0)
	for y in range(s):
		for x in range(s):
			var p := Vector2(x + 0.5, y + 0.5)
			if absf(_rr_sd(p, float(s), 5.0)) <= 1.0:
				img.set_pixel(x, y, edge)
			elif check and _seg_dist(p, Vector2(5, 9.5), Vector2(8, 12.5)) < 1.7 \
					or check and _seg_dist(p, Vector2(8, 12.5), Vector2(13, 5.5)) < 1.7:
				img.set_pixel(x, y, mark)
	return ImageTexture.create_from_image(img)


## Знаковое расстояние до скруглённого квадрата (минус — внутри).
static func _rr_sd(p: Vector2, s: float, r: float) -> float:
	var q := (p - Vector2(s * 0.5, s * 0.5)).abs() - Vector2(s * 0.5 - r, s * 0.5 - r)
	var ax := Vector2(maxf(q.x, 0.0), maxf(q.y, 0.0))
	return minf(maxf(q.x, q.y), 0.0) + ax.length() - r


## Расстояние от точки до отрезка.
static func _seg_dist(p: Vector2, a: Vector2, b: Vector2) -> float:
	var ab := b - a
	var t := clampf((p - a).dot(ab) / maxf(ab.length_squared(), 0.0001), 0.0, 1.0)
	return (a + ab * t - p).length()


## Минимум чекбокса по содержимому с запасом: движок считает минимум
## впритык (иконка + текст без запаса), и последний глиф срезается
## краем контрола — вживую пропадала буква «т» у «Бот».
static func fit_checkbox(cb: CheckBox) -> void:
	if cb == null:
		return
	var font: Font = cb.get_theme_font("font")
	var w := float(CHECK_SIZE + 4)
	if font != null:
		w += font.get_string_size(cb.text, HORIZONTAL_ALIGNMENT_LEFT, -1,
			cb.get_theme_font_size("font_size")).x
	var cur := cb.custom_minimum_size
	cb.custom_minimum_size = Vector2(maxf(cur.x, w + 8.0), cur.y)
