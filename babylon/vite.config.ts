import { defineConfig } from 'vite';

// Варианты сборки (переключаются режимом Vite):
//   vite build                — auto: площадка определяется в рантайме.
//                               Это архив для Яндекс Игр (dist/).
//   vite build --mode yandex  — принудительно Яндекс Игры (dist/).
//   vite build --mode site    — только свой сайт, без Яндекса (dist-site/).
export default defineConfig(({ mode }) => {
  const target = mode === 'site'
    ? 'standalone'
    : mode === 'yandex'
      ? 'yandex'
      : 'auto';
  const outDir = mode === 'site' ? 'dist-site' : 'dist';
  return {
    base: './',
    server: { port: 5173, host: true },
    // Значение видно коду как константа __DG_PLATFORM_TARGET__.
    define: { __DG_PLATFORM_TARGET__: JSON.stringify(target) },
    build: { outDir, emptyOutDir: true, target: 'es2022' },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
