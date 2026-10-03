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
	return _theme
