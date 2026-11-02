import { ArcRotateCamera, Engine, Scene, Vector3 } from '@babylonjs/core';
import { loadSettings } from './core/settings';
import { App } from './ui/app';

function main(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('bootCam', -Math.PI / 2, 1.1, 20, Vector3.Zero(), scene);
  camera.detachControl();
  loadSettings();
  const app = new App(scene, canvas);
  (window as unknown as Record<string, unknown>).__app = app;

  // Колесо над игрой не должно прокручивать страницу-хост. Babylon слушает
  // wheel и крутит свои ScrollViewer, но не отменяет действие браузера;
  // внутри iframe этот скролл уходит родительскому документу (scroll
  // chaining), и страница едет одновременно с игрой. preventDefault
  // оставляет прокрутку только внутри игры, не мешая Babylon.
  canvas.addEventListener('wheel', (event) => {
    // Ctrl+wheel — масштаб браузера, его не трогаем.
    if (event.ctrlKey) return;
    event.preventDefault();
  }, { passive: false });

  // Canvas может изменить размер без события window.resize: fullscreen
  // разворачивает iframe/контейнер на весь экран, а само окно сайта
  // остаётся прежним. Поэтому следим за фактическим размером canvas
  // (ResizeObserver), за fullscreen-событиями и явно пересчитываем движок.
  let lastWidth = 0;
  let lastHeight = 0;
  const syncViewport = (): void => {
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    // engine.resize() оставляем и для программных событий resize (смена
    // языка/масштаба пересобирает UI и просит пересчитать движок), но сам
    // layout перестраиваем только при реальном изменении размера.
    engine.resize();
    if (width === lastWidth && height === lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    app.relayout();
  };
  window.addEventListener('resize', syncViewport);
  document.addEventListener('fullscreenchange', syncViewport);
  document.addEventListener('webkitfullscreenchange', syncViewport);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncViewport).observe(canvas);
  }
  syncViewport();

  // Прячем стартовый лоадер после первого отрисованного кадра: движок и
  // весь UI к этому моменту уже построены, пустого экрана не видно.
  scene.onAfterRenderObservable.addOnce(() => {
    const loader = document.getElementById('boot-loader');
    if (!loader) return;
    loader.classList.add('is-hidden');
    window.setTimeout(() => loader.remove(), 400);
  });

  engine.runRenderLoop(() => scene.render());
}

main();
