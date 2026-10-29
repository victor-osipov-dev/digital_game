import { afterEach, describe, expect, it } from 'vitest';
import { setLang, t } from '../src/core/lang';

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
