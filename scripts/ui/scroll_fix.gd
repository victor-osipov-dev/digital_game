class_name ScrollFix
extends RefCounted

## Пальцем листается только то, до чего палец дотянулся мимо STOP-контролов:
## ScrollContainer начинает жест только тогда, когда контрол под пальцем
## пропускает событие дальше. Поэтому «пустые» контейнеры между кнопками
## (списки комнат, страницы лобби, главное меню) держат STOP — и при
## прокрутке пальцем просто ничего не происходит.
##
## Кнопки, поля ввода, списки и полосы прокрутки остаются STOP: ими
## пользуются, и им нужно видеть касание.
##
## Вызывать только там, где нет drop-целей: панель, принимающая
## перетаскивание (см. DropLayer), обязана остаться STOP.

const KEEP := [
	&"BaseButton", &"LineEdit", &"TextEdit", &"ScrollContainer", &"ScrollBar",
	&"Range", &"ItemList", &"Tree", &"TabContainer", &"SpinBox",
	&"ProgressBar", &"TextureRect", &"TextureButton", &"SubViewportContainer",
]

static func relax(node: Node) -> void:
	for child in node.get_children():
		var c := child as Control
		if c != null and c.mouse_filter == Control.MOUSE_FILTER_STOP and not _must_keep(c):
			c.mouse_filter = Control.MOUSE_FILTER_IGNORE
		relax(child)

static func _must_keep(c: Control) -> bool:
	for k in KEEP:
		if c.is_class(k):
			return true
	return false
