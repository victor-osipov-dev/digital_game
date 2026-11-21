class_name Deck
extends RefCounted

const VALUES := 13
const COPIES := 2
# Два джокера вместо четырёх: жёлтый и фиолетовый (см. Tile.JOKER_COLORS).
# Число зашито литералом: size() у массива — не константное выражение.
const JOKERS := 2

var tiles: Array = []

func _init() -> void:
	rebuild()

func rebuild() -> void:
	tiles.clear()
	var next_id := 1
	for c in Tile.COLOR_COUNT:
		for v in range(1, VALUES + 1):
			for _copy in COPIES:
				tiles.append(Tile.new(next_id, c, v, false))
				next_id += 1
	for c in Tile.JOKER_COLORS:
		tiles.append(Tile.new(next_id, c, 1, true))
		next_id += 1
	tiles.shuffle()

func draw() -> Tile:
	if tiles.is_empty():
		return null
	return tiles.pop_back()

func count() -> int:
	return tiles.size()

func total_tiles() -> int:
	return Tile.COLOR_COUNT * VALUES * COPIES + JOKERS
