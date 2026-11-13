import { ArcRotateCamera, Engine, Scene, Vector3 } from '@babylonjs/core';
import { loadSettings } from './core/settings';
import { loadProgress, flushProgress } from './core/progress';
import { setAdMuted } from './core/audio';
import { initSound } from './core/sound';
import { initPlatform, platform } from './platform';
import { App } from './ui/app';

async function main(): Promise<void> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const engine = new Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false });
  const scene = new Scene(engine);
  const camera = new ArcRotateCamera('bootCam', -Math.PI / 2, 1.1, 20, Vector3.Zero(), scene);
  camera.detachControl();
  // Платформа инициализируется ДО настроек: автоопределение языка
  // площадки используется как дефолт для первого запуска. Таймаут внутри,
  // игра стартует даже без сети/SDK. Затем подтягиваем облачный прогресс
  // (если он свежее локального) и только после этого читаем настройки.
  await initPlatform({ timeoutMs: 1500 });
  await loadProgress();
  const settings = loadSettings();
  initSound(settings.sound);
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
  // Здесь же сообщаем площадке, что игра готова (Yandex Game Ready и аналоги).
  scene.onAfterRenderObservable.addOnce(() => {
    const loader = document.getElementById('boot-loader');
    if (loader) {
      loader.classList.add('is-hidden');
      window.setTimeout(() => loader.remove(), 400);
    }
    // gameReady вызываем всегда, даже если стартовый лоадер уже удалён:
    // площадки (Яндекс/GamePush/CrazyGames/YouTube) ждут этот сигнал.
    platform.gameReady();
  });

  // Вкладка скрыта/свернута — игровой процесс останавливается для площадки.
  // При возврате возобновляем, только если партия реально идёт.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      platform.gameplayStop();
      flushProgress();
    } else if (app.isPlaying()) platform.gameplayStart();
  });
  window.addEventListener('blur', () => platform.gameplayStop());
  window.addEventListener('focus', () => {
    if (app.isPlaying()) platform.gameplayStart();
  });
  window.addEventListener('beforeunload', () => flushProgress());

  // Платформенные события паузы/возобновления: платформа сама сообщает о
  // показе рекламы (включая автоматический стартовый interstitial) и
  // сворачивании вкладки. На паузе глушим звук и сохраняем прогресс.
  platform.onPause(() => {
    setAdMuted(true);
    flushProgress();
    platform.gameplayStop();
  });
  platform.onResume(() => {
    setAdMuted(false);
    if (app.isPlaying()) platform.gameplayStart();
  });

  engine.runRenderLoop(() => scene.render());
}

void main();
