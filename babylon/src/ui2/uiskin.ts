import {
  Button,
  Checkbox,
  Container,
  Control,
  InputText,
  Rectangle,
  ScrollViewer,
  StackPanel,
  TextBlock,
} from '@babylonjs/gui';

import { viewWidth } from './viewport';

const FONT = 'Arial, sans-serif';

export const SKIN = {
  bg: '#12151C',
  gold: '#FFD54F',
  green: '#2E7D32',
  greenHover: '#388E3C',
  greenPress: '#1B5E20',
  blueOnline: '#1F4E79',
  blueOnlineHover: '#2A6CA8',
  blueOnlinePress: '#163A5C',
  online: '#1565C0',
  onlineHover: '#1976D2',
  onlinePress: '#0D47A1',
  deck: '#2F3B4C',
  deckHover: '#4A5C73',
  deckPress: '#263040',
  text: '#F2F2F5',
  textDim: '#9A9BA8',
  flag: '#E53935',
  drawGreen: '#43A047',
  teal: '#2E9E5B',
  rowBorder: 'rgba(255,255,255,0.22)',
  rowBorderInvalid: '#E53935',
  board: '#1A1D24',
  menuBg: '#0D2A1B',
  handBg: '#1B4332',
  panelDark: '#1B2029',
  passBg: '#1565C0',
  noteGold: '#FFE0B2',
};

export const BUTTON_STYLE: { [k: string]: ButtonTheme } = {
  green: { bg: SKIN.green, hover: SKIN.greenHover, press: SKIN.greenPress },
  blueOnline: { bg: SKIN.blueOnline, hover: SKIN.blueOnlineHover, press: SKIN.blueOnlinePress },
  online: { bg: SKIN.online, hover: SKIN.onlineHover, press: SKIN.onlinePress },
  deck: { bg: SKIN.deck, hover: SKIN.deckHover, press: SKIN.deckPress },
};

export function px(n: number): string {
  return `${n}px`;
}

type ScrollAxis = 'vertical' | 'horizontal';

export interface SmoothScrollOpts {
  // Может ли сейчас начаться drag фишки (в игре: только свой ход).
  // Если drag невозможен — свайп с фишек скроллит, как со свободного места.
  tileDragAllowed?: () => boolean;
}

// Единый реестр отмены touch-жестов: когда начинается drag фишки,
// все активные скролл-жесты и guard сбрасываются — поток событий целиком
// отдаётся drag, конфликта нет даже при ошибке хит-теста на pointerdown.
type GestureAborter = () => void;
const gestureAborters = new Set<GestureAborter>();
export function registerGestureAborter(fn: GestureAborter): () => void {
  gestureAborters.add(fn);
  return () => { gestureAborters.delete(fn); };
}
export function abortTouchGestures(): void {
  for (const fn of [...gestureAborters]) {
    try { fn(); } catch { /* жест уже мёртв */ }
  }
}

// Открытые модальные слои (правила, статистика, настройки, dropdown-списки).
// Жесты скролла слушают document в capture-фазе, поэтому при открытой
// модалке палец попадает в прямоугольники и её скроллера, и скроллера на
// заднем фоне — фон «прокручивался» бы одновременно. Скроллер, который не
// принадлежит открытому слою, жест игнорирует.
const modalLayers = new Set<Container>();
function activeModalLayers(): Container[] {
  for (const l of [...modalLayers]) if (!l.parent) modalLayers.delete(l);
  return [...modalLayers];
}
function isAncestorOf(anc: Control, node: Control): boolean {
  let c: Control | null = node;
  while (c) {
    if (c === anc) return true;
    c = (c as unknown as { parent?: Control | null }).parent ?? null;
  }
  return false;
}
export function registerModalLayer(layer: Container): () => void {
  modalLayers.add(layer);
  return () => { modalLayers.delete(layer); };
}

// Единый инерционный скролл для мыши и touch. Babylon GUI не даёт нативной
// кинетики на мобильном, поэтому работаем непосредственно с полосой прокрутки.
export function enableSmoothScroll(sc: ScrollViewer, axis: ScrollAxis = 'vertical', opts: SmoothScrollOpts = {}): void {
  const bar = (sc as unknown as {
    _verticalBar: { value: number; onValueChangedObservable?: { notifyObservers: (v: number) => void } };
    _horizontalBar: { value: number; onValueChangedObservable?: { notifyObservers: (v: number) => void } };
  })[axis === 'vertical' ? '_verticalBar' : '_horizontalBar'];
  sc.onWheelObservable.clear();
  let velocity = 0;
  let lastPos = 0;
  let lastTime = 0;
  let dragging = false;
  let raf = 0;
  const setValue = (value: number): void => {
    const next = Math.max(0, Math.min(1, value));
    bar.value = next;
    bar.onValueChangedObservable?.notifyObservers(next);
  };
  // Доступная для прокрутки область в пикселях: высота содержимого минус
  // высота окна просмотра. Перевод пунктов бара (0…1) в реальные пиксели
  // зависит от неё. Раньше шаг был фиксированной долей бара, и на разных
  // размерах экрана один и тот же оборот колеса проезжал разные расстояния.
  // Теперь скорость привязана к пикселям и одинакова на любом экране.
  const scrollRangePx = (): number => {
    const sv = sc as unknown as {
      _window?: { _currentMeasure?: { height: number; width: number } };
      _clientHeight?: number;
      _clientWidth?: number;
    };
    const host = (sc as unknown as { host?: { idealRatio?: number } }).host;
    const ratio = host?.idealRatio ?? 1;
    const content = axis === 'vertical'
      ? sv._window?._currentMeasure?.height
      : sv._window?._currentMeasure?.width;
    const view = axis === 'vertical' ? sv._clientHeight : sv._clientWidth;
    if (typeof content !== 'number' || typeof view !== 'number'
      || !Number.isFinite(content) || !Number.isFinite(view)) return 0;
    return Math.max(0, (content - view) / ratio);
  };
  const valueFromPx = (px: number): number => {
    const range = scrollRangePx();
    return range > 0 ? px / range : 0;
  };
  // Потолок скорости инерции свайпов, пикселей за кадр (не зависит от экрана).
  const MAX_VELOCITY_PX = 44;
  // Один «щелчок» колеса — фиксированные 56px пути на любом экране.
  // Прокрутка идёт коротким твином (≈7 кадров), без инерции, чтобы
  // результат был одинаковым при любом размере окна.
  const WHEEL_STEP_PX = 56;
  const WHEEL_TWEEN_FRAMES = 7;
  const animate = (): void => {
    if (Math.abs(velocity) < 0.0002) {
      raf = 0;
      return;
    }
    setValue(bar.value + velocity);
    velocity *= 0.92;
    raf = requestAnimationFrame(animate);
  };
  const startInertia = (): void => {
    if (raf === 0 && Math.abs(velocity) >= 0.0002) raf = requestAnimationFrame(animate);
  };
  // Короткий твин колеса: из текущего значения в цель за фиксированное
  // число кадров. У колеса нет инерции — иначе итоговый путь зависел бы
  // от fps и размера экрана.
  let wheelRaf = 0;
  let wheelFrom = 0;
  let wheelTo = 0;
  let wheelT = 0;
  const wheelTick = (): void => {
    wheelT += 1;
    const k = Math.min(1, wheelT / WHEEL_TWEEN_FRAMES);
    const eased = 1 - Math.pow(1 - k, 3);
    setValue(wheelFrom + (wheelTo - wheelFrom) * eased);
    if (k < 1) wheelRaf = requestAnimationFrame(wheelTick);
    else wheelRaf = 0;
  };
  const wheelStep = (sign: number): void => {
    const step = valueFromPx(WHEEL_STEP_PX);
    if (step === 0) return;
    if (wheelRaf !== 0) {
      cancelAnimationFrame(wheelRaf);
      wheelRaf = 0;
    }
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
      velocity = 0;
    }
    wheelFrom = bar.value;
    wheelTo = Math.max(0, Math.min(1, wheelFrom + sign * step));
    wheelT = 0;
    wheelRaf = requestAnimationFrame(wheelTick);
  };
  sc.onWheelObservable.add((pi) => {
    const raw = axis === 'vertical'
      ? Number((pi as unknown as { y?: number; event?: { deltaY?: number } }).y
        ?? (pi as unknown as { event?: { deltaY?: number } }).event?.deltaY ?? 0)
      : Number((pi as unknown as { x?: number; event?: { deltaX?: number; deltaY?: number } }).x
        ?? (pi as unknown as { event?: { deltaX?: number; deltaY?: number } }).event?.deltaX
        ?? (pi as unknown as { event?: { deltaY?: number } }).event?.deltaY ?? 0);
    if (!Number.isFinite(raw) || raw === 0) return;
    wheelStep(Math.sign(raw));
  });
  // Дочерние элементы ScrollViewer (текст, фишки, кнопки) перехватывают
  // Babylon-события. Для свайпа слушаем canvas в capture-фазе и проверяем
  // фактический прямоугольник конкретного скролла.
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  const controller = new AbortController();
  const disposers: Array<() => void> = [];
  sc.onDisposeObservable.add(() => {
    controller.abort();
    if (wheelRaf !== 0) cancelAnimationFrame(wheelRaf);
    for (const d of disposers) {
      try { d(); } catch { /* уже снят */ }
    }
  });
  let pointerId: number | null = null;
  let moved = false;
  const position = (event: PointerEvent): { x: number; y: number } | null => {
    if (!canvas) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const m = (sc as unknown as { _currentMeasure?: { left: number; top: number; width: number; height: number } })._currentMeasure;
    if (!m) return null;
    const x = event.clientX - canvasRect.left;
    const y = event.clientY - canvasRect.top;
    if (x < m.left || x > m.left + m.width || y < m.top || y > m.top + m.height) return null;
    return { x, y };
  };
  const contains = (control: unknown, x: number, y: number): boolean => {
    const m = (control as { _currentMeasure?: { left: number; top: number; width: number; height: number } })._currentMeasure;
    return !!m && x >= m.left && x <= m.left + m.width && y >= m.top && y <= m.top + m.height;
  };
  const hitsTile = (control: unknown, x: number, y: number): boolean => {
    const c = control as {
      children?: unknown[];
      name?: string;
    };
    if (!contains(c, x, y)) return false;
    for (const child of [...(c.children ?? [])].reverse()) {
      if (hitsTile(child, x, y)) return true;
    }
    return c.name === 'tileFig';
  };
  // Полоса прокрутки — аналитически по краям скролла: _currentMeasure у
  // бара бывает с нулевой толщиной (0) до первого рендера, поэтому
  // проверка по его прямоугольнику не срабатывает (свайп по полосе
  // крутил скролл). Полоса живёт у правого (vertical) / нижнего
  // (horizontal) края и имеет толщину barSize.
  const isScrollbarAt = (p: { x: number; y: number }): boolean => {
    const m = (sc as unknown as { _currentMeasure?: { left: number; top: number; width: number; height: number } })._currentMeasure;
    if (!m) return false;
    const barSize = Math.max(6, (sc as unknown as { barSize?: number }).barSize ?? 0);
    if (!(sc as unknown as { _verticalBar?: { isVisible: boolean } })._verticalBar?.isVisible
      && !(sc as unknown as { _horizontalBar?: { isVisible: boolean } })._horizontalBar?.isVisible) return false;
    if (axis === 'vertical') {
      return p.x >= m.left + m.width - barSize && p.x <= m.left + m.width
        && p.y >= m.top && p.y <= m.top + m.height;
    }
    return p.y >= m.top + m.height - barSize && p.y <= m.top + m.height
      && p.x >= m.left && p.x <= m.left + m.width;
  };
  // Ползунок pickable, только если у бара ненулевая мера в поперечнике
  // (у тонкого 2px-бара руки высота 0 — нативный захват там невозможен).
  const isBarPickable = (): boolean => {
    const vb = (sc as unknown as { _verticalBar?: { isVisible: boolean; _currentMeasure?: { width: number } } })._verticalBar;
    const hb = (sc as unknown as { _horizontalBar?: { isVisible: boolean; _currentMeasure?: { height: number } } })._horizontalBar;
    if (axis === 'vertical') return !!vb?.isVisible && ((vb._currentMeasure?.width ?? 0) > 0);
    return !!hb?.isVisible && ((hb._currentMeasure?.height ?? 0) > 0);
  };
  const canStartGesture = (p: { x: number; y: number }): boolean => {
    // Полоса прокрутки с pickable-ползунком — штатный drag Babylon, не
    // мешаем. Неpickable-полосу (нулевая мера) ведём сами, иначе это
    // мёртвая зона: нативный захват невозможен, а свайп мы запретили.
    if (isScrollbarAt(p) && isBarPickable()) return false;
    // Фишки исключаем из скролла, только если drag реально возможен
    // (свой ход). На чужом ходу свайп с фишек скроллит как обычно.
    // Кнопки, поля и чекбоксы допускают свайп, но их клик отменяется
    // при движении.
    if ((opts.tileDragAllowed ?? (() => true))()) {
      if ([...(sc.children ?? [])].some((child) => hitsTile(child, p.x, p.y))) return false;
    }
    return true;
  };
  const axisPosition = (p: { x: number; y: number }): number => axis === 'vertical' ? p.y : p.x;
  const down = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    // Модалка открыта, а этот скроллер не внутри неё — жест игнорируем,
    // иначе палец прокручивал бы и фон.
    for (const layer of activeModalLayers()) {
      if (layer.isVisible && !isAncestorOf(layer, sc)) return;
    }
    const p = position(event);
    if (!p || !canStartGesture(p)) return;
    pointerId = event.pointerId;
    dragging = true;
    velocity = 0;
    moved = false;
    lastPos = axisPosition(p);
    lastTime = performance.now();
  };
  const move = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== pointerId) return;
    const p = position(event);
    if (!p) return;
    const now = performance.now();
    const nextPos = axisPosition(p);
    const delta = lastPos - nextPos;
    // Палец ведёт содержимое 1:1: сдвиг в пикселях напрямую переводится
    // в пункты бара через актуальный диапазон прокрутки. Раньше диапазон
    // подменялся высотой окна, и на больших экранах тот же свайп ехал
    // медленнее.
    const change = valueFromPx(delta);
    setValue(bar.value + change);
    const elapsed = Math.max(8, now - lastTime);
    const velPx = Math.max(-MAX_VELOCITY_PX, Math.min(MAX_VELOCITY_PX, delta * (16 / elapsed)));
    velocity = valueFromPx(velPx);
    if (Math.abs(nextPos - lastPos) > 5) moved = true;
    lastPos = nextPos;
    lastTime = now;
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const up = (event: PointerEvent): void => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    if (moved) {
      // Свайп: элемент (кнопка/поле/чекбокс) не должен активироваться —
      // снимаем фокус, если поле успело его получить на pointerdown.
      if (document.activeElement && document.activeElement !== document.body) {
        (document.activeElement as HTMLElement).blur();
      }
      event.preventDefault();
      event.stopPropagation();
    }
    startInertia();
  };
  if (canvas) {
    // Document capture идёт раньше слушателей Babylon на canvas: когда
    // палец уже превратился в свайп, pointerup не активирует кнопку.
    document.addEventListener('pointerdown', down, { capture: true, signal: controller.signal });
    document.addEventListener('pointermove', move, { capture: true, passive: false, signal: controller.signal });
    document.addEventListener('pointerup', up, { capture: true, signal: controller.signal });
    document.addEventListener('pointercancel', up, { capture: true, signal: controller.signal });
  }
  // Drag фишки отменяет жест постфактум: pointerdown доходит до document
  // раньше, чем Babylon отдаёт его фишке, поэтому геометрическая проверка
  // может ошибиться — фактический старт drag сбрасывает жест.
  disposers.push(registerGestureAborter(() => {
    dragging = false;
    pointerId = null;
    moved = false;
    velocity = 0;
  }));
}

export function estimateWrappedTextHeight(text: string, width: number, fontSize: number): number {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return Math.ceil(text.length * fontSize * 0.08 + fontSize * 1.5);
  context.font = `${fontSize}px Arial`;
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines += 1; continue; }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && context.measureText(candidate).width > width) {
        lines += 1;
        line = word;
      } else {
        line = candidate;
      }
    }
    lines += 1;
  }
  return Math.ceil(lines * fontSize * 1.38 + fontSize * 0.5);
}

export interface ButtonTheme {
  bg: string;
  hover: string;
  press: string;
  border?: string;
}

export interface ButtonOpts {
  height?: number;
  fontSize?: number;
  theme?: ButtonTheme;
  onClick?: () => void;
  width?: number;
  corner?: number;
}

// Реальная ширина текста при заданном размере шрифта (Arial).
function textWidthPx(text: string, size: number): number {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  if (!ctx) return text.length * size * 0.58;
  ctx.font = `${size}px Arial, sans-serif`;
  return ctx.measureText(text).width;
}

// Если палец/мышь отжались ВНЕ кнопки, Babylon не шлёт ей pointerup: она
// остаётся «зажатой» — фон не возвращается. Глобальный слушатель сбрасывает
// фон таких кнопок.
const pressThemes = new WeakMap<Button, { base: string; press: string }>();
const pressedButtons = new Set<Button>();
let buttonResetInstalled = false;
function installButtonReset(): void {
  if (buttonResetInstalled) return;
  buttonResetInstalled = true;
  const reset = (): void => {
    if (pressedButtons.size === 0) return;
    // Микротаска: обычный pointerup Babylon обработает сам и снимет кнопку из
    // набора — тогда сбрасывать нечего. Остаются только «залипшие» кнопки,
    // у которых pointerup был отменён touch-guard'ом (жест/отпускание вне).
    queueMicrotask(() => {
      if (pressedButtons.size === 0) return;
      for (const b of pressedButtons) {
        const theme = pressThemes.get(b);
        if (theme) b.background = theme.base;
        b.scaleX = 1;
        b.scaleY = 1;
        b.alpha = 1;
      }
      pressedButtons.clear();
    });
  };
  // pointerup — обычное отжатие, pointercancel — прерванный жест (например,
  // свайп или отпускание вне канваса): в обоих случаях чистим возможный press.
  document.addEventListener('pointerup', reset, { capture: true });
  document.addEventListener('pointercancel', reset, { capture: true });
}

export function mkButton(label: string, opts: ButtonOpts = {}): Button {
  const th = opts.theme ?? BUTTON_STYLE.deck;
  const b = Button.CreateSimpleButton('b', label);
  // Button.color рисует рамку, а не подпись. Не смешиваем его с цветом
  // текста: полупрозрачная рамка иначе делала активные подписи блеклыми.
  b.color = th.border ?? '#00000000';
  b.textBlock!.color = '#ffffff';
  b.textBlock!.textWrapping = false;
  b.background = th.bg;
  b.disabledColor = '#3B4350';
  b.cornerRadius = opts.corner ?? 10;
  if (th.border !== undefined) {
    b.thickness = 1;
  } else {
    b.thickness = 0;
  }
  b.height = opts.height !== undefined ? px(opts.height) : '40px';
  if (opts.width !== undefined) b.width = px(opts.width);
  b.fontFamily = FONT;
  const wantedFont = opts.fontSize ?? 16;
  // У кнопок с фиксированной шириной подпись важнее масштаба: уменьшаем
  // шрифт по РЕАЛЬНОЙ ширине текста (а не по числу символов), чтобы он
  // целиком помещался и не резался по бокам.
  let fittingFont = wantedFont;
  if (opts.width !== undefined) {
    const avail = Math.max(10, opts.width - 20);
    while (fittingFont > 10 && textWidthPx(label, fittingFont) > avail) fittingFont -= 1;
  }
  b.fontSize = fittingFont;
  b.hoverCursor = 'pointer';
  // Отключаем встроенные анимации Babylon: на pointerdown он уменьшает
  // scaleX/scaleY и меняет alpha, а при отменённом жесте pointerup до кнопки
  // не доходит — масштаб «залипает» или накапливается поверх нашего сброса.
  // Визуальный отклик даём фоном (hover/press), он управляется надёжно.
  b.pointerEnterAnimation = () => undefined;
  b.pointerOutAnimation = () => undefined;
  b.pointerDownAnimation = () => undefined;
  b.pointerUpAnimation = () => undefined;
  b.onPointerEnterObservable.add(() => {
    if (!b.isEnabled) return;
    b.alpha = 1;
    b.background = th.hover;
    b.textBlock!.color = '#ffffff';
  });
  b.onPointerOutObservable.add(() => { b.background = th.bg; });
  b.onPointerDownObservable.add(() => {
    b.background = th.press;
    pressedButtons.add(b);
  });
  if (opts.onClick !== undefined) b.onPointerUpObservable.add(opts.onClick);
  b.onPointerUpObservable.add(() => {
    pressedButtons.delete(b);
    b.background = th.hover;
  });
  pressThemes.set(b, { base: th.bg, press: th.press });
  installButtonReset();
  return b;
}

export function setButtonLabel(b: Button, s: string): void {
  const tb = b.children.find((c) => c instanceof TextBlock) as TextBlock | undefined;
  if (!tb) return;
  tb.text = s;
  // Кнопки с фиксированной шириной: шрифт подбираем под НОВЫЙ текст,
  // чтобы «Продолжить» и другие динамические подписи не резались по
  // бокам при крупном масштабе.
  const w = b.widthInPixels;
  if (w > 0) {
    const wanted = b.fontSizeInPixels || 16;
    let f = wanted;
    const avail = Math.max(10, w - 20);
    while (f > 10 && textWidthPx(s, f) > avail) f -= 1;
    if (f !== wanted) {
      b.fontSize = f;
      tb.fontSize = f;
    }
  }
}

// Отложенная активация: контрол (чекбокс/поле ввода) НЕ реагирует на
// pointerdown. Действие выполняется на pointerup; touch-guard выше по
// capture-пути останавливает pointerup свайпа, поэтому control не
// срабатывает. Это позволяет держать палец на элементе и скроллить.
export function deferTapActivation(ctrl: Control, activate: () => void): void {
  ctrl.onPointerUpObservable.add(() => activate());
}

// Поле ввода фокусируется только на «чистом» тапе (отжатие без движения),
// а не при зажатии — зажатие позволяет скроллить без открытия клавиатуры.
// Невидимый DOM-input для вызова нативной клавиатуры на телефонах:
// Babylon рисует поле на канвасе и сам клавиатуру не поднимает.
//
// Ввод идёт через скрытый input: он получает клавиатуру, а введённый текст
// зеркалится в поле Babylon. Важно: фокус на скрытый input снимает фокус
// с canvas, из-за чего Babylon сбрасывает focusedControl и вызывает у поля
// onBlurObservable. Поэтому сессию завершаем не по blur поля Babylon, а по
// blur самого скрытого input — иначе она рвётся сразу после открытия.
let domProxyEl: HTMLInputElement | null = null;
let domProxyTarget: InputText | null = null;
// «Поле покинули» — аналог onBlurObservable для зеркального ввода.
const inputBlurHandlers = new WeakMap<InputText, Array<() => void>>();
// Ограничение длины ввода: у InputText нет maxLength, поэтому режем по факту.
const inputMaxLen = new WeakMap<InputText, number>();

/** Максимальная длина текста в поле (обрезается прямо при вводе). */
export function setInputMaxLength(input: InputText, max: number): void {
  inputMaxLen.set(input, max);
}

function onProxyInput(): void {
  if (!domProxyTarget || !domProxyEl) return;
  const max = inputMaxLen.get(domProxyTarget);
  let value = domProxyEl.value;
  if (max !== undefined && value.length > max) {
    value = value.slice(0, max);
    domProxyEl.value = value;
  }
  domProxyTarget.text = value;
}

function fireInputBlur(input: InputText): void {
  const handlers = inputBlurHandlers.get(input);
  if (!handlers) return;
  for (const h of handlers) {
    try {
      h();
    } catch {
      /* подписчик не должен ломать остальные */
    }
  }
}

// Завершить текущую сессию ввода: поле снова только для чтения,
// подписчики onInputBlur получают финальное значение.
function finalizeProxySession(): void {
  const target = domProxyTarget;
  domProxyTarget = null;
  if (!target) return;
  target.isReadOnly = true;
  fireInputBlur(target);
}

function ensureDomProxy(): HTMLInputElement {
  if (domProxyEl && domProxyEl.isConnected) return domProxyEl;
  const el = document.createElement('input');
  el.id = 'dg-input-proxy';
  el.setAttribute('autocapitalize', 'off');
  el.setAttribute('autocomplete', 'off');
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;'
    + 'border:0;padding:0;margin:0;z-index:2147483647;pointer-events:none;background:transparent;';
  // Слушатели навешиваются один раз и живут, пока элемент в DOM.
  el.addEventListener('input', onProxyInput);
  el.addEventListener('blur', finalizeProxySession);
  document.body.appendChild(el);
  domProxyEl = el;
  return el;
}

/** Подписка на «поле потеряло фокус» для зеркального DOM-ввода. */
export function onInputBlur(input: InputText, cb: () => void): void {
  const list = inputBlurHandlers.get(input) ?? [];
  list.push(cb);
  inputBlurHandlers.set(input, list);
}

export function focusInputOnTap(input: InputText): void {
  // Babylon assigns focus from pointerdown for tabIndex controls. Defer it
  // until a clean pointerup so a held press can become a scroll gesture.
  // Resolve _host at activation time; this helper runs before tree insertion.
  input.tabIndex = -1;
  input.isReadOnly = true;
  // Отключаем нативный prompt браузера («Please enter text:»), который
  // Babylon показывает при фокусе с touch.
  (input as unknown as { disableMobilePrompt?: boolean }).disableMobilePrompt = true;
  deferTapActivation(input, () => {
    const host = (input as unknown as { _host?: { moveFocusToControl?: (c: Control) => void } })._host;
    // Переход между полями без blur скрытого input: завершаем прошлую сессию.
    finalizeProxySession();
    const el = ensureDomProxy();
    el.value = input.text ?? '';
    // 1) Фокус на скрытый input — поднимает нативную клавиатуру на телефонах.
    //    Браузер при этом снимает фокус с canvas.
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    // 2) Возвращаем визуальный фокус полю Babylon (каретка/подсветка) и
    //    включаем зеркалирование — уже после возможного сброса фокуса canvas.
    input.isReadOnly = false;
    host?.moveFocusToControl?.(input);
    domProxyTarget = input;
  });
}


// Глобальный touch-guard: если палец начал на элементе UI (кнопка, поле,
// чекбокс) и сдвинулся больше порога — это жест (скролл/свайп), и элемент
// не должен активироваться. Работает в capture-фазе до Babylon: pointerup
// при движении не доходит до контрола, а фокус с полей снимается. Фишки
// (tileFig) исключены — там свой drag&drop.
let touchGuardInstalled = false;
export function installGlobalTouchGuard(rootControl: Control): void {
  if (touchGuardInstalled) return;
  touchGuardInstalled = true;
  let pid: number | null = null;
  let sx = 0;
  let sy = 0;
  let moved = false;
  const pointIn = (c: unknown, x: number, y: number): boolean => {
    const m = (c as { _currentMeasure?: { left: number; top: number; width: number; height: number } })._currentMeasure;
    return !!m && x >= m.left && x <= m.left + m.width && y >= m.top && y <= m.top + m.height;
  };
  const toGui = (e: PointerEvent): { x: number; y: number } => {
    try {
      const cv = document.getElementById('canvas') as HTMLCanvasElement | null;
      if (!cv) return { x: e.clientX, y: e.clientY };
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    } catch {
      return { x: e.clientX, y: e.clientY };
    }
  };
  const isTileAt = (x: number, y: number): boolean => {
    const walk = (c: unknown): boolean => {
      if (!c) return false;
      const cc = c as { children?: unknown[]; name?: string };
      if (!pointIn(c, x, y)) return false;
      if (cc.name === 'tileFig') return true;
      for (const child of [...(cc.children ?? [])].reverse()) {
        if (walk(child)) return true;
      }
      return false;
    };
    return walk(rootControl);
  };
  // Полоса прокрутки — штатный drag Babylon: guard её не трогает, иначе
  // нативный захват ползунка ломается (pointermove не доходит до canvas).
  const isOnAnyScrollbar = (x: number, y: number): boolean => {
    let hit = false;
    const walk = (c: unknown): void => {
      if (!c || hit) return;
      const n = c as {
        children?: unknown[];
        barSize?: number;
        _verticalBar?: { isVisible: boolean };
        _horizontalBar?: { isVisible: boolean };
        _currentMeasure?: { left: number; top: number; width: number; height: number };
      };
      if (n._verticalBar !== undefined || n._horizontalBar !== undefined) {
        const m = n._currentMeasure;
        if (m) {
          const barSize = Math.max(6, n.barSize ?? 0);
          if (n._verticalBar?.isVisible
            && x >= m.left + m.width - barSize && x <= m.left + m.width
            && y >= m.top && y <= m.top + m.height) hit = true;
          if (!hit && n._horizontalBar?.isVisible
            && y >= m.top + m.height - barSize && y <= m.top + m.height
            && x >= m.left && x <= m.left + m.width) hit = true;
        }
      }
      for (const child of [...(n.children ?? [])].reverse()) {
        if (hit) return;
        walk(child);
      }
    };
    walk(rootControl);
    return hit;
  };
  const down = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    const g = toGui(e);
    if (isTileAt(g.x, g.y)) return;
    if (isOnAnyScrollbar(g.x, g.y)) return;
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    moved = false;
  };
  const move = (e: PointerEvent): void => {
    if (pid === null || e.pointerId !== pid) return;
    if (Math.abs(e.clientX - sx) > 5 || Math.abs(e.clientY - sy) > 5) {
      moved = true;
    }
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // Drag фишки сбрасывает guard постфактум (см. abortTouchGestures):
  // геометрическая проверка на pointerdown может ошибиться.
  registerGestureAborter(() => {
    pid = null;
    moved = false;
  });
  const up = (e: PointerEvent): void => {
    if (pid === null || e.pointerId !== pid) return;
    pid = null;
    if (moved) {
      if (document.activeElement && document.activeElement !== document.body) {
        (document.activeElement as HTMLElement).blur();
      }
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const opts = { capture: true, passive: false } as const;
  document.addEventListener('pointerdown', down, opts);
  document.addEventListener('pointermove', move, opts);
  document.addEventListener('pointerup', up, { capture: true });
  document.addEventListener('pointercancel', up, { capture: true });
}

const ComboBoxDefaultHeight = '30px';

export interface LabelOpts {
  color?: string;
  fontSize?: number;
  noWrap?: boolean;
  align?: 'left' | 'right' | 'center';
  hAlign?: 'left' | 'right' | 'center';
  vAlign?: 'top' | 'bottom' | 'center';
  width?: number | string;
  height?: number | string;
  outline?: string;
  outlineWidth?: number;
}

export function mkLabel(text: string, opts: LabelOpts = {}): TextBlock {
  const tb = new TextBlock('label', text);
  tb.color = opts.color ?? SKIN.text;
  tb.fontSize = opts.fontSize ?? 16;
  tb.fontFamily = FONT;
  tb.textWrapping = !opts.noWrap;
  tb.resizeToFit = false;
  tb.textHorizontalAlignment =
    opts.align === 'left' ? Control.HORIZONTAL_ALIGNMENT_LEFT :
    opts.align === 'right' ? Control.HORIZONTAL_ALIGNMENT_RIGHT :
    Control.HORIZONTAL_ALIGNMENT_CENTER;
  tb.textVerticalAlignment =
    opts.vAlign === 'top' ? Control.VERTICAL_ALIGNMENT_TOP :
    opts.vAlign === 'bottom' ? Control.VERTICAL_ALIGNMENT_BOTTOM :
    Control.VERTICAL_ALIGNMENT_CENTER;
  if (opts.hAlign !== undefined) {
    tb.horizontalAlignment =
      opts.hAlign === 'left' ? Control.HORIZONTAL_ALIGNMENT_LEFT :
      opts.hAlign === 'right' ? Control.HORIZONTAL_ALIGNMENT_RIGHT :
      Control.HORIZONTAL_ALIGNMENT_CENTER;
  }
  if (opts.width !== undefined) tb.width = typeof opts.width === 'number' ? px(opts.width) : opts.width;
  if (opts.height !== undefined) tb.height = typeof opts.height === 'number' ? px(opts.height) : opts.height;
  else tb.height = ComboBoxDefaultHeight;
  if (opts.outline !== undefined) {
    tb.outlineColor = opts.outline;
    tb.outlineWidth = opts.outlineWidth ?? Math.max(3, Math.floor((opts.fontSize ?? 16) / 6));
  }
  return tb;
}

export interface SoftPanelOpts {
  bg?: string;
  bgAlpha?: number;
  border?: string;
  thickness?: number;
  corner?: number;
  width?: number | string;
  height?: number | string;
}

export interface SoftPanel {
  root: Container;
  fill: Rectangle;
}

// Панель с полупрозрачной заливкой: заливка — отдельный слой, чтобы
// прозрачность не касалась содержимого (в Godot это StyleBoxFlat с альфой).
export function softPanel(opts: SoftPanelOpts = {}): SoftPanel {
  const root = new Container('sp');
  root.width = opts.width !== undefined ? (typeof opts.width === 'number' ? px(opts.width) : opts.width) : '100%';
  root.height = opts.height !== undefined ? (typeof opts.height === 'number' ? px(opts.height) : opts.height) : '100%';
  const fill = new Rectangle('fill');
  fill.cornerRadius = opts.corner ?? 10;
  fill.thickness = opts.thickness ?? 0;
  fill.color = opts.border ?? '#00000000';
  fill.background = opts.bg ?? '#00000000';
  fill.alpha = opts.bgAlpha ?? 1;
  fill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  fill.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  fill.width = '100%';
  fill.height = '100%';
  root.addControl(fill);
  return { root, fill };
}

export function gapControl(h: number): Control {
  const c = new Control('gap');
  c.height = px(h);
  return c;
}

export function spacerW(w: number): Control {
  const c = new Control('gapw');
  c.width = px(w);
  return c;
}

export function column(gapPx = 14): StackPanel {
  const sp = new StackPanel('col');
  sp.isVertical = true;
  sp.spacing = gapPx;
  return sp;
}

export function hrow(gapPx = 12): StackPanel {
  const sp = new StackPanel('hrow');
  sp.isVertical = false;
  sp.spacing = gapPx;
  return sp;
}

export interface CheckRowOpts {
  height: number;
  fontSize: number;
  maxLabelWidth?: number;
  onChange?: (v: boolean) => void;
}

// Горизонтальный ряд: чекбокс + подпись, вся пара центрируется —
// соответствие fit_checkbox оригинала.
export function checkboxRow(label: string, checked: boolean, opts: CheckRowOpts): { root: StackPanel; setChecked: (v: boolean) => void } {
  const row = new StackPanel('crow');
  row.isVertical = false;
  row.height = px(opts.height);
  row.spacing = 8;
  row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  const cb = new Checkbox('cb');
  cb.width = px(Math.round(opts.height * 0.45));
  cb.height = cb.width;
  cb.isChecked = checked;
  cb.color = SKIN.gold;
  cb.background = '#00000000';
  cb.thickness = Math.max(2, Math.round(opts.height / 15));
  // Тoggle только на «чистом» тапе (отжатие без движения): зажатие
  // позволяет скроллить, не меняя состояние.
  // Checkbox Babylon переключается внутри _onPointerDown, поэтому
  // блокируем штатный toggle и выполняем его вручную при pointerup.
  cb.isReadOnly = true;
  deferTapActivation(cb, () => {
    cb.isChecked = !cb.isChecked;
  });
  cb.onIsCheckedChangedObservable.add((v: boolean) => {
    opts.onChange?.(v);
  });
  // Ширина подписи — оценка по числу символов (ширина глифа ≈ 0.62em),
  // чтобы ряд «обнимал» содержимое целиком.
  const naturalLabelWidth = Math.round(opts.fontSize * 0.62 * label.length) + Math.round(opts.fontSize * 0.5);
  const lblW = opts.maxLabelWidth === undefined ? naturalLabelWidth : Math.min(naturalLabelWidth, opts.maxLabelWidth);
  const lbl = mkLabel(label, { fontSize: opts.fontSize, width: lblW, height: opts.height, hAlign: 'left' });
  lbl.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  row.addControl(cb);
  row.addControl(lbl);
  return { root: row, setChecked: (v: boolean) => { cb.isChecked = v; } };
}

export interface DropOpt {
  label: string;
  value: string;
}

// Кастомный dropdown: кнопка OptionButton + попап-список поверх экрана
// (в @babylonjs/gui v8 выпадающих списков нет).
export interface DropdownHandle {
  root: StackPanel;
  setOptions: (items: string[], currentIndex: number, onPick?: (index: number) => void) => void;
  getSelected: () => number;
}

export interface DropdownCtx {
  openFor: (anchor: Control, items: string[], currentIndex: number, onPick: (index: number) => void, widthPx?: number) => void;
}

export function dropdownRow(
  label: string,
  ctx: DropdownCtx,
  opts: { height?: number; fontSize?: number; btnWidth?: number; lblWidth?: number; stacked?: boolean },
): DropdownHandle {
  const height = opts.height ?? 42;
  const fontSize = opts.fontSize ?? 16;
  const row = new StackPanel('dro');
  row.isVertical = !!opts.stacked;
  if (opts.stacked) {
    // Узкий экран: подпись сверху, кнопка под ней — иначе ряд шире
    // доступного места и уезжает за край модалки/меню.
    row.width = '100%';
    row.height = px(height * 2 + 4);
    row.spacing = 4;
  } else {
    row.height = px(height);
    row.spacing = label ? 10 : 0;
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  }
  // Подпись всегда прижата к левому краю своего места: раньше текст
  // центрировался внутри фиксированной ширины метки и ряды «плясали».
  const lbl = mkLabel(label, { fontSize, noWrap: true, height, hAlign: 'left', align: 'left' });
  if (!label) {
    lbl.width = px(0);
  } else if (opts.stacked) {
    lbl.width = '100%';
  } else if (opts.lblWidth !== undefined) {
    lbl.width = px(opts.lblWidth);
  } else {
    lbl.resizeToFit = true;
  }
  let items: string[] = [];
  let cur = -1;
  let pick: (i: number) => void = () => {};
  const btnW = opts.btnWidth ?? Math.round(height * 2.8);
  const btn = mkButton('', { height, fontSize, theme: BUTTON_STYLE.deck });
  btn.width = px(btnW);
  // Подпись кнопки подгоняем под ширину: длинные значения («Невозможный»)
  // иначе упираются в края. Базовый шрифт запоминаем, чтобы при выборе
  // короткого значения размер вернулся к прежнему.
  const btnBaseFont = btn.fontSizeInPixels || fontSize;
  const applyBtnText = (s: string): void => {
    btn.textBlock!.text = s;
    const avail = Math.max(10, btnW - 20);
    let f = btnBaseFont;
    while (f > 10 && textWidthPx(s, f) > avail) f -= 1;
    btn.fontSize = f;
    btn.textBlock!.fontSize = f;
  };
  if (opts.stacked) btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  row.addControl(lbl);
  row.addControl(btn);
  btn.onPointerClickObservable.add(() => {
    ctx.openFor(btn, items, cur, (i) => {
      cur = i;
      applyBtnText(items[i] ?? '');
      pick(i);
    }, btnW);
  });
  return {
    root: row,
    setOptions: (lst, currentIndex, onPick) => {
      items = lst;
      cur = currentIndex;
      applyBtnText(lst[currentIndex] ?? '');
      if (onPick !== undefined) pick = onPick;
    },
    getSelected: () => cur,
  };
}

// Полноэкранный catcher с меню-списком; закрывается тапом мимо.
export function popupList(
  rootOverlay: Container,
  anchor: Control,
  items: string[],
  currentIdx: number,
  onPick: (idx: number) => void,
  fontSize: number,
  widthPx?: number,
): void {
  const catcher = new Container('catch');
  catcher.width = '100%';
  catcher.height = '100%';
  catcher.isPointerBlocker = true;
  catcher.zIndex = 1000;
  let closed = false;
  const unregister = registerModalLayer(catcher);
  const closePopup = (): void => {
    if (closed) return;
    closed = true;
    rootOverlay.removeControl(catcher);
    unregister();
    window.removeEventListener('wheel', onWheelClose);
    window.removeEventListener('keydown', onKeyClose);
  };
  const onWheelClose = (): void => closePopup();
  const onKeyClose = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closePopup();
  };
  // Тап мимо списка — закрыть; скролл/нажатие другого элемента — тоже.
  catcher.onPointerUpObservable.add(() => closePopup());
  window.addEventListener('wheel', onWheelClose);
  window.addEventListener('keydown', onKeyClose);
  let listW = 200;
  try {
    const m = (anchor as unknown as { _currentMeasure?: { width: number; top: number } })._currentMeasure;
    if (m && m.width > 20) listW = Math.round(m.width);
  } catch {
    listW = 200;
  }
  listW = Math.max(listW, 160);
  if (widthPx !== undefined && widthPx > 40) listW = Math.max(listW, widthPx);
  let ax = 8;
  let ay = 8;
  try {
    const m = (anchor as unknown as { _currentMeasure?: { left: number; top: number; height: number; width: number } })._currentMeasure;
    if (m && Number.isFinite(m.left) && Number.isFinite(m.top)) {
      ax = Math.max(4, Math.round(m.left));
      ay = Math.round(m.top + m.height + 2);
    }
  } catch {
    ax = 8;
    ay = 8;
  }
  // Список не должен быть уже самой длинной подписи: иначе текст липнет к
  // краям («Невозможный» и т. п.). Расширяем под пункт, но не за экран.
  let widest = 0;
  for (const it of items) widest = Math.max(widest, Math.ceil(textWidthPx(it, fontSize)));
  const screenW = viewWidth();
  const maxAllowed = screenW > 0 ? Math.max(160, screenW - ax - 10) : listW + 40;
  listW = Math.min(Math.max(listW, widest + 28), maxAllowed);
  const list = new StackPanel('list');
  list.width = px(listW);
  list.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  list.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  list.left = px(Math.min(Math.max(4, ax), 2000));
  list.top = px(Math.min(Math.max(4, ay), 2000));
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    const b = mkButton(it, {
      theme: i === currentIdx
        ? { bg: '#37578C', hover: '#3B5D96', press: '#2C456E' }
        : BUTTON_STYLE.deck,
      height: fontSize + 12,
      fontSize,
      width: listW,
      corner: 6,
    });
    b.width = px(listW);
    b.onPointerClickObservable.add(() => {
      closePopup();
      onPick(i);
    });
    list.addControl(b);
  }
  catcher.addControl(list);
  rootOverlay.addControl(catcher);
}

// Модальный оверлей: Container-корень (иначе дети-кнопки не получают
// события) + отдельный «затемнитель»-лист, который перехватывает клики
// мимо панели.
export function modalOverlay(
  host: Container,
  name: string,
  opts: { alpha?: number; zIndex?: number } = {},
): { overlay: Container; close: () => void } {
  const overlay = new Container(name);
  overlay.width = '100%';
  overlay.height = '100%';
  overlay.zIndex = opts.zIndex ?? 900;
  const dim = new Rectangle(name + 'Dim');
  dim.background = '#000000';
  dim.alpha = opts.alpha ?? 0.78;
  dim.thickness = 0;
  dim.width = '100%';
  dim.height = '100%';
  dim.isPointerBlocker = true;
  overlay.addControl(dim);
  const unregister = registerModalLayer(overlay);
  host.addControl(overlay);
  return {
    overlay,
    close: () => {
      host.removeControl(overlay);
      unregister();
    },
  };
}
