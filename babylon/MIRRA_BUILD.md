# Сборка для Mirra Games

Сборка: `npm run build:mirra` → `dist-mirra/`, архив: `powershell -File tools/make-mirra-zip.ps1` → `antiskleroz-mirra.zip`.

Готовые скриншоты для заявки: `babylon/screenshots/` — `menu.png`, `table.png`,
`shop.png`, `achievements.png`, `mobile.png`.

## Что внутри

- `index.html` в корне архива, все пути относительные — работает и в корне домена, и в подпапке.
- `mirra-sdk.js` — MirraWeb SDK из [MirraSDK/SDK5](https://github.com/MirraSDK/SDK5) (`Runtime/MirraWeb/Plugins/mirraSDK.jspre`), подключён в `<head>` до кода игры.
- `mirra-config.js` — настройки SDK и фич игры (см. ниже), редактируется без пересборки.
  Исходники SDK лежат в `babylon/sdk/mirra/` и копируются только в Mirra-сборку.
- Игра целиком офлайн-способна: если SDK/сеть недоступны, меню и партия работают, реклама/платежи просто не показываются.

## MirraWeb SDK

SDK сам определяет площадку, на которой открыта игра: Яндекс Игры, VK, OK, CrazyGames,
GameDistribution, Y8, Lagged, MirraHub, Lumix, Welwise, WgPlayground, YouTube Playables и др.
Настройки конкретных площадок (appId, gameId, blockIds) можно добавить в `sdk/mirra/mirra-config.js`
в объект `window.MIRRA_SETTINGS` — SDK читает их при старте.

`window.Module = {}` в `<head>` нужен потому, что SDK написан для Unity WebGL и в конце
регистрирует себя на `Module`; на обычной странице этого объекта нет.

Провайдер площадки: `src/platform/mirra.ts` (`id = mirra`), режим сборки — `vite --mode mirra`.

Что подключено через SDK:

| Возможность | MirraSDK | Наш вызов |
|---|---|---|
| Реклама interstitial | `ads.invokeInterstitial` | `platform.showInterstitial()` |
| Реклама rewarded | `ads.invokeRewarded` | `platform.showRewarded()` |
| Покупки | `payments.purchase` | `platform.purchase(id)` |
| Восстановление покупок | `payments.updatePurchases` / `purchases` | `platform.getPurchases()` при запуске |
| Облачные данные | `data.get/set/flush` | `platform.storageGet/Set`, `loadProgress/saveProgress` |
| Достижения | `achievements.unlock` | `platform.unlockAchievement(id)` |
| Язык | `language.current` | `platform.getInterfaceLang()` |
| Устройство | `device.isMobile` | `platform.getDevice()` |
| Аналитика | `analytics.gameIsReady/gameplayStart/gameplayStop` | `main.ts` и экран партии |
| Пауза | visibility/blur | `platform.onPause/onResume` |

## Монетизация

Реклама:

- **Rewarded**: подсказка лучшего хода. Показывается только по явному нажатию и подтверждению.
  На площадке без rewarded подсказка остаётся бесплатной (одна на игрока за партию).
- **Rewarded**: «Удвоить монеты» на экране победы (только если реклама доступна).
- **Interstitial**: после партии при «Заново»/«В меню», не чаще, чем раз в 2 партии,
  и никогда во время хода. Покупка «Без рекламы» отключает их полностью.
- Баннеров нет: они перекрывают стол на телефоне.

Покупки (теги товаров должны совпадать с настройками в панели MirraHub/площадки):

| Тег | Что даёт | Тип |
|---|---|---|
| `remove_ads` | отключает межстраничную рекламу | постоянный |
| `theme_pack` | открывает все темы стола и фишек | постоянный |

Отдельные темы («Синий лорд», «Бордо», «Янтарь», «Мрамор») можно купить и за монеты,
которые начисляются за партии и достижения. При покупке за реальные деньги товар
выдаётся сразу и восстанавливается при следующем запуске (`restorePurchases`).

## Достижения

ID достижений игры (создайте их в панели площадки с теми же id, если она поддерживает
серверные достижения; иначе они работают локально и всё равно показываются в меню):

`first_win`, `wins_5`, `wins_20`, `games_10`, `joker_use`, `combo_5`, `fast_win`,
`four_players`, `daily_play`, `no_hint_win`, `quick_win`, `collector`, `rich_1000`.

## Настройки игры (mirra-config.js)

```js
window.MIRRA_FEATURES = {
  // Не подключаться к игровому серверу из меню (кнопка «Играть с другими» остаётся).
  // false убирает фоновые WebSocket-ошибки на площадках без внешней сети.
  menuAutoConnect: false,
  // false — полностью скрыть сетевой режим и кнопку «Играть с другими».
  online: true,
};
```

Если на площадке доступен ваш игровой сервер, поставьте `menuAutoConnect: true`, чтобы
в меню работала плашка «Кто-то играет по сети» и автоподключение.

## Отправка в MirraHub

1. Войти в MirraHub → **Publish** → **Submit a game**.
2. Загрузить `antiskleroz-mirra.zip` (HTML5, `index.html` в корне).
3. В платежах проекта создать товары `remove_ads` и `theme_pack`; в достижениях —
   id из списка выше (если площадка их поддерживает).
4. Добавить скриншоты из `babylon/screenshots/` и описание.
5. Если Mirra попросит настройки площадки (blockIds/appId/gameId) — их можно
   вписать в `mirra-config.js` внутри архива, пересборка не нужна.

## Проверка перед отправкой

1. `npm test` — 73 теста.
2. `npm run build:mirra`, распаковать архив в пустую папку, открыть через HTTP-сервер
   (не `file://`).
3. Консоль: нет ошибок, есть строка `[platform] id=mirra`.
4. Пройти партию, проверить: меню → «Играть», «+ Ряд», перетаскивание числа в ряд,
   сортировку руки, зелёную/красную подсветку, итог партии с монетами.
5. Проверить экран победы на телефоне (390×844): рука не занимает пол-экрана,
   кнопки доступны, магазин и достижения скроллятся.
6. Проверить, что без сети игра стартует и партия играется.
