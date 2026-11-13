import { defineConfig } from 'vite';

// GamePush: projectId и publicToken из панели проекта. Это публичные
// идентификаторы, они всё равно видны в HTML. Можно переопределить
// переменными окружения GP_PROJECT_ID / GP_PUBLIC_TOKEN.
const GP_PROJECT_ID = process.env.GP_PROJECT_ID || '33206';
const GP_PUBLIC_TOKEN = process.env.GP_PUBLIC_TOKEN || 'tQnsjN2tXtslvcQnmZamPkLYjPHDKsnL';

// Сниппет GamePush ставится перед </body>. Сначала синхронный маркер (чтобы
// площадка опознавалась до загрузки SDK), затем загрузчик game-score.js.
function gamePushSnippet(): string {
  const query = `?projectId=${encodeURIComponent(GP_PROJECT_ID)}`
    + `&publicToken=${encodeURIComponent(GP_PUBLIC_TOKEN)}`
    + '&callback=onGPInit';
  return `<script>
    window.__dgGP = null;
    window.__dgGamePush = true;
    window.onGPInit = function (gp) {
      window.__dgGP = gp;
      window.gp = gp;
    };
    ((s,c,o,r,e)=>{var f=0,p=0,t={},a=r.map(()=>new AbortController),l=u=>{t[u]=1;var d=c.createElement(o);d.async=1;d.src=u+e;d.onerror=()=>{d.remove();n()};var g=c.getElementsByTagName(o)[0];g.parentNode.insertBefore(d,g)},n=()=>{var u=r.find(u=>!t[u]);u&&l(u)},j=u=>{if(f)return;f=1;a.forEach(x=>x.abort());u?l(u):n()},q=()=>{++p>=r.length&&j()};r.forEach((u,i)=>s.fetch(u,{method:"HEAD",signal:a[i].signal}).then(x=>x.ok?j(u):q()).catch(q));s.setTimeout(j,5000)})(window,document,"script",atob("aHR0cHM6Ly9ncy5lcG9uZXNoLmNvbS9zZGsvZ2FtZS1zY29yZS5qcyxodHRwczovL3MzLmdhbWVwdXNoLmNvbS9maWxlcy9ncy9zZGsvZ2FtZS1zY29yZS5qcyxodHRwczovL3MzLWV1LmdhbWVwdXNoLmNvbS9zZGsvZ2FtZS1zY29yZS5qcyxodHRwczovL2dhbWVwdXNoLmNvbS9zZGsvZ2FtZS1zY29yZS5qcw==").split(","),"${query}");
  </script>`;
}

function gamePushSnippetPlugin(): { name: string; transformIndexHtml: (html: string) => string } {
  return {
    name: 'dg-gamepush-snippet',
    transformIndexHtml(html: string): string {
      return html.replace('</body>', `${gamePushSnippet()}\n</body>`);
    },
  };
}

// Скрипт SDK площадки ставится в <head> ДО кода игры (требование YouTube
// Playables; для CrazyGames — штатное подключение v3).
function sdkScriptPlugin(src: string): { name: string; transformIndexHtml: (html: string) => string } {
  return {
    name: 'dg-sdk-script',
    transformIndexHtml(html: string): string {
      return html.replace('</head>', `  <script src="${src}"></script>\n</head>`);
    },
  };
}

const CRAZYGAMES_SDK = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
const YOUTUBE_SDK = 'https://www.youtube.com/game_api/v1';

// Варианты сборки (переключаются режимом Vite):
//   vite build                  — auto: площадка определяется в рантайме.
//                                 Это архив для Яндекс Игр (dist/).
//   vite build --mode yandex    — принудительно Яндекс Игры (dist/).
//   vite build --mode site      — только свой сайт, без Яндекса (dist-site/).
//   vite build --mode gamepush  — GamePush SDK + своя панель (dist-gamepush/).
//   vite build --mode crazygames — CrazyGames SDK v3 (dist-crazygames/).
//   vite build --mode youtube   — YouTube Playables SDK (dist-youtube/).
export default defineConfig(({ mode }) => {
  const target = mode === 'site'
    ? 'standalone'
    : mode === 'yandex'
      ? 'yandex'
      : mode === 'gamepush'
        ? 'gamepush'
        : mode === 'crazygames'
          ? 'crazygames'
          : mode === 'youtube'
            ? 'youtube'
            : 'auto';
  const outDir = mode === 'site'
    ? 'dist-site'
    : mode === 'gamepush'
      ? 'dist-gamepush'
      : mode === 'crazygames'
        ? 'dist-crazygames'
        : mode === 'youtube'
          ? 'dist-youtube'
          : 'dist';
  const plugins = mode === 'gamepush'
    ? [gamePushSnippetPlugin()]
    : mode === 'crazygames'
      ? [sdkScriptPlugin(CRAZYGAMES_SDK)]
      : mode === 'youtube'
        ? [sdkScriptPlugin(YOUTUBE_SDK)]
        : [];
  return {
    base: './',
    server: { port: 5173, host: true },
    plugins,
    // Значение видно коду как константа __DG_PLATFORM_TARGET__.
    define: { __DG_PLATFORM_TARGET__: JSON.stringify(target) },
    build: { outDir, emptyOutDir: true, target: 'es2022' },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
