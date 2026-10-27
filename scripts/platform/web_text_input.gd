extends Node
## Прототип явного ввода текста на Web (v4, поллинг вместо коллбеков).
##
## Вместо встроенной виртуальной клавиатуры Godot (у которой на мобильных
## пропадает курсор и рассинхронизируется значение с LineEdit) рисуем поверх
## активного LineEdit настоящий HTML <input> через JavaScriptBridge:
##   * видимый нативный курсор;
##   * нативный maxlength (нельзя набрать больше лимита);
##   * явная синхронизация значения и позиции каретки в обе стороны.
##
## v2: движок на touchstart/mousedown зовёт canvas.focus() — блокируем перехватом.
## v3: движок включает IME-хелпер (contentEditable div.ime) и каждые 100 мс
##     зовёт ime.focus() — обезвреживаем (focus -> no-op).
## v4: JS->GD коллбеки (create_callback) не пробивают границу — синхронизация
##     целиком поллингом каждый кадр: eval возвращает значение напрямую
##     (__gTIv — строка, __gTIenter — флаг Enter, __gTIfocusAge — мс с последнего
##     кадра, когда наш input держал DOM-фокус). Порядок кадра: сначала тянем
##     значение из JS (JS->GD), потом отдаём актуальный текст (GD->JS).
##
## Активен только на Web и только на тач-устройствах. Вне этих условий —
## полный no-op, поля работают как обычно.

const FOCUS_LOST_MS := 500.0

var _js = null
var _enabled := false
var _dom_ready := false
var _line: LineEdit = null


func _ready() -> void:
	if not OS.has_feature("web"):
		set_process(false)
		return
	if not Engine.has_singleton("JavaScriptBridge"):
		set_process(false)
		return
	_js = Engine.get_singleton("JavaScriptBridge")
	var window = _js.get_interface("window")
	_js.eval("window.__godotTI_hasTouch = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0));", true)
	_enabled = bool(window.get("__godotTI_hasTouch")) or DisplayServer.is_touchscreen_available()
	if not _enabled:
		set_process(false)
		return
	_install_dom()


func _exit_tree() -> void:
	if _dom_ready and _js != null:
		_js.eval("if(window.__godotTI) window.__godotTI.destroy();", true)


func _process(_dt: float) -> void:
	if not _dom_ready:
		return
	var focus = null
	var vp := get_viewport()
	if vp != null:
		focus = vp.gui_get_focus_owner()
	var target: LineEdit = focus as LineEdit if focus is LineEdit else null
	if target != null and target.editable and target.is_visible_in_tree():
		_sync_dom(target)
		_show_for(target)
		_check_dom_focus(target)
	else:
		_clear()


func _install_dom() -> void:
	_js.eval("""
var godotTI = { el: null, log: null, focusAt: 0, lastFocusOk: Date.now(), lastAct: '', stackBudget: 3 };
function godotTIl(m) {
  if (!godotTI.log) {
    godotTI.log = document.createElement('div');
    godotTI.log.id = 'godotTI-log';
    godotTI.log.style.cssText = 'position:fixed;left:4px;top:4px;z-index:2147483646;background:rgba(0,0,0,.6);color:#4ade80;font:10px/1.3 monospace;padding:6px;max-width:78%;pointer-events:none;white-space:pre-wrap;border-radius:6px;';
    document.body.appendChild(godotTI.log);
  }
  godotTI.log.appendChild(document.createTextNode(m + String.fromCharCode(10)));
  while (godotTI.log.childNodes.length > 14) godotTI.log.removeChild(godotTI.log.firstChild);
}
function godotTItag(e) {
  if (!e) return 'none';
  if (e === godotTI.el) return 'INPUT(ours)';
  var t = e.tagName || String(e);
  if (e.id) t += '#' + e.id;
  return t;
}
if (!window.__godotTI) {
  window.__gTIv = '';
  window.__gTIenter = 0;
  window.__gTIfocusAge = 0;
  var el = document.createElement('input');
  godotTI.el = el;
  el.setAttribute('autocomplete', 'off');
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  el.setAttribute('spellcheck', 'false');
  el.style.position = 'fixed';
  el.style.zIndex = '2147483647';
  el.style.display = 'none';
  el.style.boxSizing = 'border-box';
  el.style.outline = 'none';
  el.style.border = 'none';
  el.style.margin = '0';
  el.style.borderRadius = '8px';
  el.style.fontFamily = 'sans-serif';
  document.body.appendChild(el);
  godotTIl('godotTI v4 installed');
  var imeNeutered = 0;
  var neuterIME = function () {
    if (imeNeutered >= 3) return;
    var list = document.querySelectorAll('div.ime');
    for (var i = 0; i < list.length; i++) {
      if (list[i].__gNeutered) continue;
      list[i].__gNeutered = true;
      list[i].focus = function () { godotTIl('ime.focus BLOCKED'); };
      imeNeutered += 1;
      godotTIl('IME div neutered (' + imeNeutered + ')');
    }
  };
  var imePoll = setInterval(function () {
    neuterIME();
    if (imeNeutered >= 1) { godotTI.imePollTicks -= 1; }
    if (godotTI.imePollTicks <= 0) clearInterval(imePoll);
  }, 300);
  godotTI.imePoll = imePoll;
  godotTI.imePollTicks = 20;
  var cv = document.querySelector('canvas');
  if (cv) {
    var origFocus = cv.focus.bind(cv);
    cv.focus = function () {
      if (document.activeElement === el) {
        godotTIl('canvas.focus BLOCKED (typing)');
        return;
      }
      origFocus();
    };
  } else {
    godotTIl('no canvas found');
  }
  el.addEventListener('input', function () {
    window.__gTIv = el.value;
    godotTIl('js input len=' + el.value.length);
  });
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.__gTIenter = 1;
    }
  });
  el.addEventListener('blur', function () {
    var now = Date.now();
    godotTIl('el.blur act=' + godotTItag(document.activeElement));
    if (godotTI.stackBudget > 0) {
      godotTI.stackBudget -= 1;
      try {
        var st = (new Error().stack || '').split(String.fromCharCode(10));
        for (var i = 1; i < Math.min(4, st.length); i++) godotTIl(' st ' + st[i].replace(/^\\s+/, '').slice(0, 110));
      } catch (err) {}
    }
  });
  window.__godotTI = {
    el: el,
    show: function (vpW, vpH, gx, gy, gw, gh, value, maxLen, password, placeholder, fontPx, color, bg, pad) {
      var c = document.querySelector('canvas');
      if (!c) return;
      var r = c.getBoundingClientRect();
      var sx = r.width / vpW, sy = r.height / vpH;
      var wantType = password ? 'password' : 'text';
      var wantMax = maxLen > 0 ? maxLen : -1;
      if (el.type !== wantType) el.type = wantType;
      if (el.maxLength !== wantMax) el.maxLength = wantMax;
      if (el.value !== value) { el.value = value; window.__gTIv = value; }
      if (el.placeholder !== placeholder) el.placeholder = placeholder;
      el.style.left = (r.left + gx * sx) + 'px';
      el.style.top = (r.top + gy * sy) + 'px';
      el.style.width = (gw * sx) + 'px';
      el.style.height = (gh * sy) + 'px';
      el.style.fontSize = (fontPx * sy) + 'px';
      el.style.color = color;
      el.style.backgroundColor = bg;
      el.style.paddingLeft = (pad * sx) + 'px';
      el.style.paddingRight = (pad * sx) + 'px';
      el.style.display = 'block';
      if (document.activeElement === el) {
        godotTI.lastFocusOk = Date.now();
      } else {
        var now = Date.now();
        if (now - godotTI.focusAt >= 150) {
          godotTI.focusAt = now;
          el.focus();
          try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) {}
          godotTIl('el.focus requested (kb)');
        }
      }
      window.__gTIfocusAge = Date.now() - godotTI.lastFocusOk;
      var act = godotTItag(document.activeElement);
      if (act !== godotTI.lastAct) {
        godotTI.lastAct = act;
        godotTIl('act=' + act);
      }
    },
    hide: function () {
      el.style.display = 'none';
      window.__gTIv = '';
      if (document.activeElement === el) el.blur();
    },
    destroy: function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (godotTI.imePoll) clearInterval(godotTI.imePoll);
    }
  };
}
""", true)
	_dom_ready = true


func _sync_dom(edit: LineEdit) -> void:
	var js_v = _js.eval("window.__gTIv", true)
	if typeof(js_v) == TYPE_STRING:
		var v := String(js_v)
		if edit.max_length > 0 and v.length() > edit.max_length:
			v = v.substr(0, edit.max_length)
		if edit.text != v:
			edit.text = v
			edit.caret_column = v.length()
			_js.eval("godotTIl('GD applied len=" + str(v.length()) + " ph=" + edit.placeholder_text.replace(" ", "_") + "');", true)
	else:
		_js.eval("godotTIl('GD poll: type=" + type_string(typeof(js_v)) + "');", true)
	var ef = _js.eval("window.__gTIenter", true)
	if typeof(ef) == TYPE_INT or typeof(ef) == TYPE_FLOAT:
		if int(ef) == 1:
			_js.eval("window.__gTIenter = 0;", true)
			edit.text_submitted.emit(edit.text)
			edit.release_focus()


func _show_for(edit: LineEdit) -> void:
	_line = edit
	var vp := get_viewport()
	if vp == null:
		return
	var vp_size := vp.get_visible_rect().size
	if vp_size.x <= 0.0 or vp_size.y <= 0.0:
		return
	var r := edit.get_global_rect()
	var font_px := float(edit.get_theme_font_size("font_size"))
	if font_px <= 0.0:
		font_px = 16.0
	var call := "window.__godotTI && window.__godotTI.show(%f,%f,%f,%f,%f,%f,%s,%d,%s,%s,%f,%s,%s,%f);"
	_js.eval(call % [
		vp_size.x, vp_size.y,
		r.position.x, r.position.y, r.size.x, r.size.y,
		JSON.stringify(edit.text),
		edit.max_length,
		"true" if edit.secret else "false",
		JSON.stringify(edit.placeholder_text),
		font_px,
		JSON.stringify(_css_color(edit.get_theme_color("font_color"))),
		JSON.stringify(_css_color(_field_bg(edit))),
		_field_pad(edit),
	], true)


## Наш input потерял DOM-фокус (закрыли клавиатуру снаружи) и не вернул его
## дольше FOCUS_LOST_MS — отпускаем gui-фокус LineEdit, иначе show() будет
## дёргать el.focus() по кругу и клавиатура зациклится.
func _check_dom_focus(target: LineEdit) -> void:
	var age = _js.eval("window.__gTIfocusAge", true)
	if typeof(age) == TYPE_INT or typeof(age) == TYPE_FLOAT:
		if float(age) > FOCUS_LOST_MS:
			_js.eval("godotTIl('GD release: focus age=" + str(int(float(age))) + "ms');", true)
			target.release_focus()


func _clear() -> void:
	if _line == null:
		return
	_line = null
	if _dom_ready:
		_js.eval("window.__godotTI && window.__godotTI.hide();", true)


func _field_bg(edit: LineEdit) -> Color:
	var sb := edit.get_theme_stylebox("normal")
	if sb is StyleBoxFlat:
		return (sb as StyleBoxFlat).bg_color
	return Color(1, 1, 1, 1)


func _field_pad(edit: LineEdit) -> float:
	var sb := edit.get_theme_stylebox("normal")
	if sb != null:
		return sb.get_content_margin(SIDE_LEFT) + 2.0
	return 8.0


func _css_color(c: Color) -> String:
	return "rgba(%d,%d,%d,%.3f)" % [
		int(round(c.r * 255.0)), int(round(c.g * 255.0)),
		int(round(c.b * 255.0)), c.a,
	]
