// Настройки MirraWeb SDK для сборки под Mirra Games.
// framework.forcePlatformType = '' — площадка определяется автоматически
// (Яндекс, VK, OK, CrazyGames, GameDistribution, Y8, Lagged, MirraHub…).
// ID/ключи конкретных площадок (например gameId для GameDistribution или
// appId для VK) Mirra может добавить сюда, не пересобирая игру.
window.MIRRA_SETTINGS = {
  framework: { forcePlatformType: '' },
  logger: {
    enableTextMessages: false,
    enableWarningMessages: true,
    enableExceptionMessages: true,
  },
};

// Возможности игры на площадке. autoConnect=false — не подключаться к
// игровому серверу из меню (кнопка «Играть с другими» остаётся). Это
// убирает фоновые сетевые ошибки в консоли на площадках, где внешние
// соединения недоступны; при необходимости поставьте true.
window.MIRRA_FEATURES = {
  menuAutoConnect: false,
  // true — кнопка «Играть с другими» и сетевой режим доступны.
  online: true,
};
