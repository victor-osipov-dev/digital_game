class_name TurnPlanner
extends RefCounted

const LEVEL_EASY := 0
const LEVEL_MEDIUM := 1
const LEVEL_HARD := 2
const LEVEL_IMPOSSIBLE := 3

const BUDGET_MEDIUM := 8000
const BUDGET_HARD := 40000

const CAP_EASY := 60
const CAP_MEDIUM := 80
const CAP_HARD := 400
const CAP_IMPOSSIBLE := 900

const BONUS_STEAL := 6
const BONUS_BRIDGE := 12
const BONUS_REBUILD := 4
const REBUILD_GROUP_MAX := 8

# Бережение джокеров — стратегия, которая включается со «Среднего» уровня.
#
# Джокер закрывает любую дырку, поэтому в начале игры он ценнее почти любой
# фишки: ход с джокером лучше отложить, если есть ход без него. Под конец
# игры джокер — лишь способ выложить руку, и штраф почти нулевой. Штраф
# растёт с уровнем: чем умнее бот, тем дольше он держит джокер.
const JOKER_HOLD := [0.0, 40.0, 55.0, 70.0]
const JOKER_HOLD_LATE := [0.0, 8.0, 12.0, 16.0]

static func plan(state: GameState, level: int) -> Dictionary:
	var p := new()
	return p._plan(state, level)

var _state: GameState = null
var _level: int = LEVEL_MEDIUM
var _candidates: Array = []
var _hand_ids: Dictionary = {}
var _base_points: int = 0
var _need30: bool = false
var _n_ref: int = 0
var _budget: int = 0
var _best: Dictionary = {}
var _suffix: Array = []
var _cover: Array = []

var _rb_budget: int = 0
var _rb_emitted: int = 0
var _rb_mand: Array = []
var _rb_opt: Array = []
var _rb_refs: Array = []
var _rb_src: Dictionary = {}
var _rb_hand_ids: Dictionary = {}
var _rb_old_pts: int = 0
var _rb_groups: Array = []
var _rb_used_opt: int = 0
var _rb_pool_max: int = 8
var _rb_opt_max: int = 8
var _rb_cand_cap: int = 150
var _rb_try_budget: int = 6000
var _rb_pairs: bool = true

func _plan(state: GameState, level: int) -> Dictionary:
	_state = state
	_level = clampi(level, 0, 3)
	_setup_rebuild_params()
	if state.finished:
		return _action("end")
	_base_points = state.opening_points()
	_need30 = state.require_30 and state.first_turn
	_build_candidates()
	_rank_candidates()
	if _level == LEVEL_EASY:
		# Сначала пробуем выложить: ход из руки лучше, чем брать из колоды
		# вслепую. Берём из колоды только когда выкладывать нечего — и то
		# не всегда: иногда выгоднее пропустить, чтобы не тащить лишнее.
		var single := _random_single()
		if not single.is_empty():
			return single
		if state.can_draw() and randf() < 0.35:
			return _action("draw")
	_budget = BUDGET_MEDIUM if _level <= LEVEL_MEDIUM else BUDGET_HARD
	_search()
	if not _best.is_empty():
		return {
			action="place",
			ops=_best.ops,
			points=int(_best.points),
			tiles=_best.tiles,
		}
	if state.can_draw():
		return _action("draw")
	if state.can_skip():
		return _action("skip")
	return _action("end")

func _action(kind: String) -> Dictionary:
	return {action=kind, ops=[], points=0, tiles=[]}

func _build_candidates() -> void:
	_candidates = []
	_hand_ids = {}
	_n_ref = 0
	var hand := _state.hand()
	for t in hand:
		_hand_ids[(t as Tile).id] = true
	_pack_candidates(hand)
	_extend_candidates(hand)
	if _level >= LEVEL_IMPOSSIBLE:
		_steal_candidates(hand)
		_bridge_candidates(hand)
	if _level >= LEVEL_MEDIUM:
		_rebuild_candidates(hand)

func _rank_candidates() -> void:
	_candidates.sort_custom(func(a, b): return int(a.score) > int(b.score))
	var cap := CAP_MEDIUM
	match _level:
		LEVEL_EASY:
			cap = CAP_EASY
		LEVEL_MEDIUM:
			cap = CAP_MEDIUM
		LEVEL_HARD:
			cap = CAP_HARD
		LEVEL_IMPOSSIBLE:
			cap = CAP_IMPOSSIBLE
	if _candidates.size() > cap:
		_candidates.resize(cap)

func _mk(kind: String, refs: Array, ops: Array, hand_ids: Array, points: int, hand_points: int, bonus: int, jokers := 0) -> Dictionary:
	return {
		kind=kind,
		refs=refs,
		ops=ops,
		hand_ids=hand_ids,
		points=points,
		hand_points=hand_points,
		bonus=bonus,
		jokers=jokers,
		score=points * 4 + hand_ids.size() * 6 + bonus - jokers * _joker_penalty(),
	}

## Цена траты джокера в текущий момент игры. Ноль на «Лёгком» — там бот
## играет как попало. На остальных уровнях штраф высок в начале и тает к
## концу: держать джокер имеет смысл, пока в колоде много фишек, а под конец
## он нужен, чтобы выложить руку.
func _joker_penalty() -> float:
	if _level <= LEVEL_EASY:
		return 0.0
	var total := float(_state.deck.total_tiles())
	var left := float(_state.tiles_left_in_deck())
	if total <= 0.0:
		return float(JOKER_HOLD_LATE[_level])
	var late := 1.0 - left / total
	return lerpf(float(JOKER_HOLD[_level]), float(JOKER_HOLD_LATE[_level]), late)

static func _joker_count(tiles: Array) -> int:
	var n := 0
	for t in tiles:
		if (t as Tile).is_joker:
			n += 1
	return n

func _next_n_ref() -> String:
	var ref := "n%d" % _n_ref
	_n_ref += 1
	return ref

func _random_single() -> Dictionary:
	var pool := []
	for c in _candidates:
		if int(c.score) <= 0:
			continue
		if _need30 and _base_points + int(c.hand_points) < Rules.OPENING_POINTS:
			continue
		pool.append(c)
	if pool.is_empty():
		return {}
	var c: Dictionary = pool[randi() % pool.size()]
	return {
		action="place",
		ops=(c.ops as Array).duplicate(),
		points=int(c.points),
		tiles=(c.hand_ids as Array).duplicate(),
	}

# ---------------------------------------------------------------- кандидаты

func _pack_candidates(hand: Array) -> void:
	var n := hand.size()
	if n < 3 or n > 16:
		return
	var limit := 1 << n
	for mask in limit:
		if mask == 0:
			continue
		var subset := []
		for i in n:
			if (mask & (1 << i)) != 0:
				subset.append(hand[i])
		if subset.size() < 3:
			continue
		if not _shape_ok(subset):
			continue
		for order in _orders(subset):
			var res := Rules.validate_row(order)
			if not res["ok"]:
				continue
			var pts := Rules.row_points(order)
			var ref := _next_n_ref()
			var ops := []
			for t in order:
				ops.append({op="place", tile=(t as Tile).id, to=ref, index=99})
			_candidates.append(_mk("new", [ref], ops, _ids(order), pts, pts, 0, _joker_count(order)))
			break

func _extend_candidates(hand: Array) -> void:
	if hand.is_empty():
		return
	var combos := _combos(hand, 1, 3)
	for row in _state.table:
		var r := row as GameState.Row
		if r == null or r.tiles.is_empty():
			continue
		var old_res := Rules.validate_row(r.tiles)
		var old_pts := Rules.row_points(r.tiles) if old_res["ok"] else 0
		var ref := "r%d" % r.id
		for combo in combos:
			if not _shape_ok(r.tiles + combo):
				continue
			var done := false
			for order in _orders(combo):
				if done:
					break
				for side in 2:
					var comp: Array = order + r.tiles if side == 1 else r.tiles + order
					var res := Rules.validate_row(comp)
					if not res["ok"]:
						continue
					var new_pts := Rules.row_points(comp)
					var ops := []
					for i in order.size():
						var idx := int(i) if side == 1 else 99
						ops.append({op="place", tile=(order[i] as Tile).id, to=ref, index=idx})
					_candidates.append(_mk(
						"extend", [ref], ops, _ids(order),
						new_pts - old_pts, _hand_points(order, res), 0, _joker_count(order)
					))
					done = true
					break

# ---------------------------------------------------------------- утилиты

static func _ids(tiles: Array) -> Array:
	var out := []
	for t in tiles:
		out.append((t as Tile).id)
	return out

static func _hand_points(tiles: Array, res: Dictionary) -> int:
	var jv: Dictionary = res["joker_values"]
	var total := 0
	for t in tiles:
		if (t as Tile).is_joker:
			total += int(jv.get((t as Tile).id, 0))
		else:
			total += (t as Tile).value
	return total

static func _shape_ok(tiles: Array) -> bool:
	var colors_ok := true
	var values_ok := true
	var c0 := -1
	var v0 := -1
	for t in tiles:
		if (t as Tile).is_joker:
			continue
		if c0 == -1:
			c0 = (t as Tile).color
		elif (t as Tile).color != c0:
			colors_ok = false
		if v0 == -1:
			v0 = (t as Tile).value
		elif (t as Tile).value != v0:
			values_ok = false
		if not colors_ok and not values_ok:
			return false
	return colors_ok or values_ok

func _orders(tiles: Array) -> Array:
	var sorted := tiles.duplicate()
	Tile.sort_tiles(sorted)
	var out := [sorted]
	var jokers := []
	var reals := []
	for t in sorted:
		if (t as Tile).is_joker:
			jokers.append(t)
		else:
			reals.append(t)
	if jokers.is_empty() or sorted.size() > 8:
		return out
	_collect_orders(0, 0, sorted.size(), jokers.size(), [], reals, jokers, out)
	return out

func _collect_orders(start: int, depth: int, n: int, k: int, pos: Array, reals: Array, jokers: Array, out: Array) -> void:
	if depth == k:
		var chosen := {}
		for p in pos:
			chosen[p] = true
		var order := []
		var ridx := 0
		for i in n:
			if chosen.has(i):
				order.append(jokers[pos.find(i)])
			else:
				order.append(reals[ridx])
				ridx += 1
		out.append(order)
		return
	for p in range(start, n - (k - depth) + 1):
		pos.append(p)
		_collect_orders(p + 1, depth + 1, n, k, pos, reals, jokers, out)
		pos.pop_back()

func _combos(hand: Array, lo: int, hi: int) -> Array:
	var out := []
	var n := hand.size()
	for combo_size in range(lo, hi + 1):
		if combo_size > n:
			break
		var idx := []
		for i in combo_size:
			idx.append(i)
		while true:
			var combo := []
			for i in idx:
				combo.append(hand[i])
			out.append(combo)
			var p := combo_size - 1
			while p >= 0 and idx[p] == n - combo_size + p:
				p -= 1
			if p < 0:
				break
			idx[p] += 1
			for q in range(p + 1, combo_size):
				idx[q] = idx[q - 1] + 1
	return out

func _steal_candidates(hand: Array) -> void:
	if hand.size() < 2:
		return
	var combos := _combos(hand, 2, 3)
	for row in _state.table:
		var r := row as GameState.Row
		if r == null or r.tiles.size() < 4:
			continue
		var old_res := Rules.validate_row(r.tiles)
		if not old_res["ok"]:
			continue
		var old_pts := Rules.row_points(r.tiles)
		var src_ref := "r%d" % r.id
		for ti in r.tiles.size():
			var t: Tile = r.tiles[ti]
			var rest := r.tiles.duplicate()
			rest.remove_at(ti)
			if rest.size() < 3:
				continue
			if not Rules.validate_row(rest)["ok"]:
				continue
			var rest_pts := Rules.row_points(rest)
			for combo in combos:
				if not _steal_prefilter(t, combo):
					continue
				var pool: Array = combo.duplicate()
				pool.append(t)
				if not _shape_ok(pool):
					continue
				for order in _orders(pool):
					var res := Rules.validate_row(order)
					if not res["ok"]:
						continue
					var pos := int(order.find(t))
					var s_order: Array = order.duplicate()
					s_order.erase(t)
					var ref := _next_n_ref()
					var ops := []
					for s in s_order:
						ops.append({op="place", tile=(s as Tile).id, to=ref, index=99})
					ops.append({op="move", tile=t.id, from=src_ref, to=ref, index=pos})
					var new_pts := Rules.row_points(order)
					_candidates.append(_mk(
						"steal", [src_ref, ref], ops, _ids(s_order),
						new_pts + rest_pts - old_pts,
						_hand_points(s_order, res),
						BONUS_STEAL, _joker_count(s_order)
					))
					break

static func _steal_prefilter(t: Tile, combo: Array) -> bool:
	var colors_ok := true
	var values_ok := true
	var c0 := -1
	var v0 := -1
	for s in combo:
		if (s as Tile).is_joker:
			continue
		if c0 == -1:
			c0 = (s as Tile).color
		elif (s as Tile).color != c0:
			colors_ok = false
		if v0 == -1:
			v0 = (s as Tile).value
		elif (s as Tile).value != v0:
			values_ok = false
	if not colors_ok and not values_ok:
		return false
	if t.is_joker:
		return true
	if colors_ok and (c0 == -1 or c0 == t.color):
		return true
	if values_ok and (v0 == -1 or v0 == t.value):
		return true
	return false

func _bridge_candidates(hand: Array) -> void:
	if hand.is_empty():
		return
	var runs: Array = []
	for row in _state.table:
		var r := row as GameState.Row
		if r == null or r.tiles.size() < 3:
			continue
		if (r.tiles[0] as Tile).is_joker or (r.tiles[r.tiles.size() - 1] as Tile).is_joker:
			continue
		var res := Rules.validate_row(r.tiles)
		if res["ok"] and String(res["kind"]) == "run":
			runs.append(r)
	for i in runs.size():
		for j in runs.size():
			if i == j:
				continue
			var A: GameState.Row = runs[i]
			var B: GameState.Row = runs[j]
			var col_a := (A.tiles[0] as Tile).color
			var col_b := (B.tiles[0] as Tile).color
			if col_a != col_b:
				continue
			var a_max := (A.tiles[A.tiles.size() - 1] as Tile).value
			var b_min := (B.tiles[0] as Tile).value
			if b_min <= a_max + 1:
				continue
			var gap := []
			for v in range(a_max + 1, b_min):
				gap.append(v)
			if gap.size() > hand.size():
				continue
			var gap_tiles := _fill_gap(hand, gap, col_a)
			if gap_tiles.is_empty() and not gap.is_empty():
				continue
			var comp: Array = A.tiles + gap_tiles + B.tiles
			var res := Rules.validate_row(comp)
			if not res["ok"]:
				continue
			var ref_a := "r%d" % A.id
			var ref_b := "r%d" % B.id
			var ops := []
			for h in gap_tiles:
				ops.append({op="place", tile=(h as Tile).id, to=ref_a, index=99})
			for h in B.tiles:
				ops.append({op="move", tile=(h as Tile).id, from=ref_b, to=ref_a, index=99})
			var gain := Rules.row_points(comp) - Rules.row_points(A.tiles) - Rules.row_points(B.tiles)
			_candidates.append(_mk(
				"bridge", [ref_a, ref_b], ops, _ids(gap_tiles),
				gain, _hand_points(gap_tiles, res), BONUS_BRIDGE, _joker_count(gap_tiles)
			))

func _fill_gap(hand: Array, gap: Array, color: int) -> Array:
	var used := {}
	var out := []
	for v in gap:
		var found: Tile = null
		for h in hand:
			var ht := h as Tile
			if used.has(ht.id) or ht.is_joker:
				continue
			if ht.color == color and ht.value == v:
				found = ht
				break
		if found == null:
			for h in hand:
				var ht := h as Tile
				if used.has(ht.id) or not ht.is_joker:
					continue
				found = ht
				break
		if found == null:
			return []
		used[found.id] = true
		out.append(found)
	return out

# ------------------------------------------------ капитальная перестройка стола

func _rebuild_candidates(hand: Array) -> void:
	if hand.is_empty():
		return
	_rb_emitted = 0
	var rows: Array = []
	for r in _state.table:
		var row := r as GameState.Row
		if row != null and not row.tiles.is_empty():
			rows.append(row)
	for i in rows.size():
		if _rb_emitted >= _rb_cand_cap:
			return
		var ri := rows[i] as GameState.Row
		if ri.tiles.size() <= _rb_pool_max:
			_rebuild_try([ri], hand)
		if not _rb_pairs:
			continue
		for j in range(i + 1, rows.size()):
			if _rb_emitted >= _rb_cand_cap:
				return
			var rj := rows[j] as GameState.Row
			if ri.tiles.size() + rj.tiles.size() <= _rb_pool_max:
				_rebuild_try([ri, rj], hand)

func _setup_rebuild_params() -> void:
	# параметры перестройки стола по уровням (дефолт — «невозможный»):
	# средний — только одиночные строки, малый пул и бюджет (базовые вставки);
	# сложный — одиночки и пары строк, полный перебор по сути тот же, но
	# глубже обрезан (пул меньше, кандидатов и попыток меньше).
	if _level == LEVEL_MEDIUM:
		_rb_pool_max = 6
		_rb_opt_max = 4
		_rb_cand_cap = 12
		_rb_try_budget = 900
		_rb_pairs = false
	elif _level == LEVEL_HARD:
		_rb_pool_max = 7
		_rb_opt_max = 6
		_rb_cand_cap = 40
		_rb_try_budget = 2500
		_rb_pairs = true

func _rebuild_relevant(hand: Array, pool: Array) -> Array:
	var out := []
	for h in hand:
		var ht := h as Tile
		if ht.is_joker:
			out.append(ht)
			continue
		for p in pool:
			var pt := p as Tile
			if pt.is_joker:
				out.append(ht)
				break
			if pt.value == ht.value:
				out.append(ht)
				break
			if pt.color == ht.color and absi(pt.value - ht.value) <= 6:
				out.append(ht)
				break
	if out.size() > _rb_opt_max:
		out.resize(_rb_opt_max)
	return out

func _rebuild_try(src_rows: Array, hand: Array) -> void:
	_rb_mand = []
	_rb_opt = []
	_rb_refs = []
	_rb_src = {}
	_rb_hand_ids = {}
	_rb_old_pts = 0
	for r in src_rows:
		var row := r as GameState.Row
		_rb_refs.append("r%d" % row.id)
		_rb_old_pts += Rules.row_points(row.tiles)
		for t in row.tiles:
			_rb_mand.append(t)
			_rb_src[(t as Tile).id] = "r%d" % row.id
	_rb_opt = _rebuild_relevant(hand, _rb_mand)
	if _rb_opt.is_empty():
		return
	for t in _rb_opt:
		_rb_hand_ids[(t as Tile).id] = true
	_rb_groups = []
	_rb_used_opt = 0
	_rb_budget = _rb_try_budget
	_rb_cover()

func _rb_cover() -> void:
	_rb_budget -= 1
	if _rb_budget <= 0:
		return
	if _rb_mand.is_empty():
		if _rb_used_opt >= 1:
			_rb_emit()
		return
	var t_min: Tile = _rb_mand[0]
	for g in _rb_groups_for(t_min):
		if _rb_budget <= 0:
			return
		var g_ids := {}
		for t in g:
			g_ids[(t as Tile).id] = true
		var new_mand := []
		for t in _rb_mand:
			if not g_ids.has((t as Tile).id):
				new_mand.append(t)
		var new_opt := []
		var added := 0
		for t in _rb_opt:
			if g_ids.has((t as Tile).id):
				added += 1
			else:
				new_opt.append(t)
		var saved_mand := _rb_mand
		var saved_opt := _rb_opt
		var saved_used := _rb_used_opt
		_rb_mand = new_mand
		_rb_opt = new_opt
		_rb_used_opt += added
		_rb_groups.append(g)
		_rb_cover()
		_rb_groups.pop_back()
		_rb_mand = saved_mand
		_rb_opt = saved_opt
		_rb_used_opt = saved_used
		if _rb_budget <= 0:
			return

func _rb_groups_for(t_min: Tile) -> Array:
	var out := []
	if _rb_budget <= 0 or _rb_emitted >= _rb_cand_cap:
		return out
	out.append_array(_rb_set_groups(t_min))
	if _rb_budget <= 0:
		return out
	out.append_array(_rb_series_groups(t_min))
	var filtered := []
	for g in out:
		if g.size() > REBUILD_GROUP_MAX:
			continue
		var has_t := false
		for t in g:
			if (t as Tile).id == t_min.id:
				has_t = true
				break
		if has_t:
			filtered.append(g)
	return filtered

func _rb_set_groups(t_min: Tile) -> Array:
	var out := []
	var all: Array = _rb_mand + _rb_opt
	var jokers := []
	var values := []
	if not t_min.is_joker:
		values.append(t_min.value)
	else:
		var seen := {}
		for t in all:
			var tt := t as Tile
			if not tt.is_joker and not seen.has(tt.value):
				seen[tt.value] = true
				values.append(tt.value)
	for t in all:
		if (t as Tile).is_joker:
			jokers.append(t)
	for v in values:
		if _rb_budget <= 0:
			return out
		var reals := []
		for t in all:
			var tt := t as Tile
			if not tt.is_joker and tt.value == v:
				reals.append(tt)
		var cand: Array = reals + jokers
		for size in range(Rules.MIN_TILES, Rules.MAX_SET + 1):
			if size > cand.size():
				break
			for subset in _rb_subsets(cand, size):
				_rb_budget -= 1
				if _rb_budget <= 0:
					return out
				if not Rules.validate_row(subset)["ok"]:
					continue
				out.append(subset)
	return out

func _rb_series_groups(t_min: Tile) -> Array:
	var out := []
	var all: Array = _rb_mand + _rb_opt
	var colors := []
	if not t_min.is_joker:
		colors.append(t_min.color)
	else:
		var seen := {}
		for t in all:
			var tt := t as Tile
			if not tt.is_joker and not seen.has(tt.color):
				seen[tt.color] = true
				colors.append(tt.color)
		if colors.is_empty():
			return out
	var v0 := -1
	if not t_min.is_joker:
		v0 = t_min.value
	else:
		for t in all:
			if not (t as Tile).is_joker:
				v0 = (t as Tile).value
				break
	if v0 < 0:
		return out
	var jokers := []
	for t in all:
		if (t as Tile).is_joker:
			jokers.append(t)
	var dj := jokers.size()
	var lo := maxi(Rules.MIN_VALUE, v0 - 6)
	var hi := mini(Rules.MAX_VALUE, v0 + 6)
	for c in colors:
		for s in range(lo, v0 + 1):
			for e in range(v0, hi + 1):
				if _rb_budget <= 0:
					return out
				var reals := []
				var holes: Array = []
				for v in range(s, e + 1):
					var pick: Tile = null
					for t in _rb_mand:
						var tt := t as Tile
						if not tt.is_joker and tt.color == c and tt.value == v:
							pick = tt
							break
					if pick == null:
						for t in _rb_opt:
							var tt := t as Tile
							if not tt.is_joker and tt.color == c and tt.value == v:
								pick = tt
								break
					if pick == null:
						holes.append(v)
					else:
						reals.append(pick)
				if holes.size() > dj:
					continue
				if reals.size() + mini(dj, holes.size() + 2) < Rules.MIN_TILES:
					continue
				if reals.size() > REBUILD_GROUP_MAX:
					continue
				for m in range(holes.size(), mini(dj, holes.size() + 2) + 1):
					if reals.size() + m > REBUILD_GROUP_MAX:
						continue
					for subset in _rb_subsets(jokers, m):
						_rb_budget -= 1
						if _rb_budget <= 0:
							return out
						var extra := m - holes.size()
						for trail in range(extra + 1):
							_rb_budget -= 1
							if _rb_budget <= 0:
								return out
							var order := []
							var head := extra - trail
							var idx := 0
							for k in head:
								order.append(subset[idx])
								idx += 1
							for v in range(s, e + 1):
								var placed := false
								for t in reals:
									if (t as Tile).value == v:
										order.append(t)
										placed = true
										break
								if not placed:
									order.append(subset[idx])
									idx += 1
							for k in range(idx, m):
								order.append(subset[k])
							if not Rules.validate_row(order)["ok"]:
								continue
							out.append(order)
	return out

func _rb_emit() -> void:
	if _rb_emitted >= _rb_cand_cap:
		return
	var ops := []
	var hand_ids := []
	var pts := 0
	var hp := 0
	var new_refs := []
	for g in _rb_groups:
		var ref := _next_n_ref()
		new_refs.append(ref)
		var res := Rules.validate_row(g)
		if not res["ok"]:
			return
		pts += Rules.row_points(g)
		var jv: Dictionary = res["joker_values"]
		for i in g.size():
			var t := g[i] as Tile
			if _rb_hand_ids.has(t.id):
				ops.append({op="place", tile=t.id, to=ref, index=i})
				hand_ids.append(t.id)
				if t.is_joker:
					hp += int(jv.get(t.id, 0))
				else:
					hp += t.value
			else:
				ops.append({op="move", tile=t.id, from=String(_rb_src.get(t.id, "")), to=ref, index=i})
	if hand_ids.is_empty():
		return
	var refs: Array = _rb_refs + new_refs
	# Штраф считаем только по джокерам, взятым из руки: джокер, который
	# уже лежал на столе и просто переехал в новый ряд, бот не тратил.
	var played := []
	for g in _rb_groups:
		for t in g:
			if hand_ids.has((t as Tile).id):
				played.append(t)
	_candidates.append(_mk("rebuild", refs, ops, hand_ids, pts - _rb_old_pts, hp,
		BONUS_REBUILD, _joker_count(played)))
	_rb_emitted += 1

static func _rb_subsets(items: Array, k: int) -> Array:
	var out := []
	if k <= 0:
		return [[]]
	if items.size() < k:
		return out
	_rb_subsets_rec(items, 0, [], k, out)
	return out

static func _rb_subsets_rec(items: Array, start: int, cur: Array, k: int, out: Array) -> void:
	if cur.size() == k:
		out.append(cur.duplicate())
		return
	for i in range(start, items.size() - (k - cur.size()) + 1):
		cur.append(items[i])
		_rb_subsets_rec(items, i + 1, cur, k, out)
		cur.pop_back()

# ---------------------------------------------------------------- поиск

func _search() -> void:
	var n := _candidates.size()
	_suffix = []
	_suffix.resize(n + 1)
	_suffix[n] = 0.0
	for i in range(n - 1, -1, -1):
		_suffix[i] = float(_suffix[i + 1]) + maxf(0.0, float(_candidates[i].score))
	_cover = []
	_cover.resize(n + 1)
	_cover[n] = {}
	for i in range(n - 1, -1, -1):
		var m: Dictionary = (_cover[i + 1] as Dictionary).duplicate()
		for tid in _candidates[i].hand_ids:
			m[tid] = true
		_cover[i] = m
	_best = {}
	_bt(0, {}, {}, [], 0, 0)

func _bt(i: int, used_hand: Dictionary, used_refs: Dictionary, chosen: Array, hand_points: int, cur_score: int) -> void:
	_budget -= 1
	if _budget <= 0:
		return
	if i >= _candidates.size():
		_leaf(chosen, used_hand, hand_points, cur_score)
		return
	if not _best.is_empty() and cur_score + int(_suffix[i]) <= int(_best.score) and not _can_win(used_hand, i):
		return
	var c: Dictionary = _candidates[i]
	if not _conflicts(c, used_hand, used_refs):
		var uh := used_hand.duplicate()
		var ur := used_refs.duplicate()
		for tid in c.hand_ids:
			uh[tid] = true
		for ref in c.refs:
			ur[ref] = true
		chosen.append(c)
		var next_hp := hand_points + int(c.hand_points)
		var next_score := cur_score + int(c.score)
		if uh.size() == _hand_ids.size():
			_leaf(chosen, uh, next_hp, next_score)
		else:
			_bt(i + 1, uh, ur, chosen, next_hp, next_score)
		chosen.pop_back()
		if _budget <= 0:
			return
	_bt(i + 1, used_hand, used_refs, chosen, hand_points, cur_score)

func _leaf(chosen: Array, used_hand: Dictionary, hand_points: int, cur_score: int) -> void:
	if chosen.is_empty():
		return
	var wins := used_hand.size() == _hand_ids.size()
	if _need30 and _base_points + hand_points < Rules.OPENING_POINTS:
		return
	if not wins and cur_score <= 0:
		return
	if not _best.is_empty() and cur_score <= int(_best.score) and not wins:
		return
	var ops := []
	var pts := 0
	var tiles := []
	for c in chosen:
		ops.append_array(c.ops)
		pts += int(c.points)
		tiles.append_array(c.hand_ids)
	_best = {ops=ops, points=pts, tiles=tiles, score=cur_score, win=wins}
	if wins:
		_budget = 0

func _conflicts(c: Dictionary, used_hand: Dictionary, used_refs: Dictionary) -> bool:
	for tid in c.hand_ids:
		if used_hand.has(tid):
			return true
	for ref in c.refs:
		if used_refs.has(ref):
			return true
	return false

func _can_win(used_hand: Dictionary, i: int) -> bool:
	for tid in _hand_ids:
		if used_hand.has(tid):
			continue
		if not (_cover[i] as Dictionary).has(tid):
			return false
	return true
