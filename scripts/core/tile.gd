class_name Tile
extends RefCounted

# const Lang — после перечислений и констант: порядок определений
# в глобальной области проверяет линтер (class-definitions-order).

# YELLOW и PURPLE — цвета джокеров, а не ряды колоды: в сериях и наборах
# они не участвуют, фишка с is_joker проверяется раньше цвета. Нужны,
# чтобы джокер был виден на столе (цветная подложка под звездой).
enum TColor { RED, BLUE, BLACK, ORANGE, YELLOW, PURPLE }

# Обычных цветов по-прежнему четыре: столько же серий и наборов.
const COLOR_COUNT := 4
# Вместо четырёх джокеров (по одному на цвет) — два, жёлтый и фиолетовый.
const JOKER_COLORS := [TColor.YELLOW, TColor.PURPLE]
const Lang := preload("res://scripts/core/lang.gd")

var id: int = 0
var color: int = TColor.RED
var value: int = 1
var is_joker: bool = false

func _init(p_id: int = 0, p_color: int = TColor.RED, p_value: int = 1, p_joker: bool = false) -> void:
	id = p_id
	color = p_color
	value = p_value
	is_joker = p_joker

static func color_hex(c: int) -> String:
	match c:
		TColor.RED:
			return "E53935"
		TColor.BLUE:
			return "1E88E5"
		TColor.BLACK:
			return "212121"
		TColor.ORANGE:
			return "FB8C00"
		TColor.YELLOW:
			return "FDD835"
		TColor.PURPLE:
			return "8E24AA"
	return "9E9E9E"

static func color_name(c: int) -> String:
	match c:
		TColor.RED:
			return Lang.t("красный")
		TColor.BLUE:
			return Lang.t("синий")
		TColor.BLACK:
			return Lang.t("чёрный")
		TColor.ORANGE:
			return Lang.t("оранжевый")
		TColor.YELLOW:
			return Lang.t("жёлтый")
		TColor.PURPLE:
			return Lang.t("фиолетовый")
	return "?"

static func sort_tiles(tiles: Array) -> void:
	tiles.sort_custom(_less)

static func _less(a: Tile, b: Tile) -> bool:
	if a.is_joker != b.is_joker:
		return not a.is_joker
	if a.color != b.color:
		return a.color < b.color
	return a.value < b.value
