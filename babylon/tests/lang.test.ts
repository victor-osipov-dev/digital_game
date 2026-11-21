import { afterEach, describe, expect, it } from 'vitest';
import { resolveLang, setLang, t } from '../src/core/lang';

afterEach(() => setLang('ru'));

describe('localization', () => {
  it('translates the app name and tile colors', () => {
    setLang('en');
    expect(t('Антисклероз')).toBe('Anti-Sclerosis');
    expect(t('красный')).toBe('red');
    expect(t('фиолетовый')).toBe('purple');
  });

  it('translates already-formatted server messages with placeholders', () => {
    setLang('en');
    expect(t('Самый первый ход игры - минимум 30 очков (у вас 24)'))
      .toBe('The first turn needs at least 30 points (you have 24)');
    expect(t('Комнат найдено: 12 · серверов в сети: 2 из 2'))
      .toBe('Rooms found: 12 · servers online: 2 of 2');
  });
});

describe('resolveLang: язык при запуске', () => {
  it('смена языка в панели площадки перебивает старое сохранение', () => {
    // Старые сохранения не имеют метки lang_platform — язык SDK выигрывает.
    expect(resolveLang('ru', 'en', null)).toBe('en');
    expect(resolveLang('ru', 'en', 'ru')).toBe('en');
    expect(resolveLang('en', 'ru', 'en')).toBe('ru');
  });

  it('ручной выбор игрока сохраняется, пока язык площадки не менялся', () => {
    expect(resolveLang('en', 'ru', 'ru')).toBe('en');
    expect(resolveLang('ru', 'ru', 'ru')).toBe('ru');
    expect(resolveLang('en', 'en', 'en')).toBe('en');
  });

  it('неподдерживаемый язык SDK — английский, без SDK — сохранение или ru', () => {
    expect(resolveLang('ru', 'fr', null)).toBe('en');
    expect(resolveLang('ru', 'zh-CN', 'ru')).toBe('en');
    expect(resolveLang('en', null, null)).toBe('en');
    expect(resolveLang(null, null, null)).toBe('ru');
  });
});
