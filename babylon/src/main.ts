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
  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());
}

main();
