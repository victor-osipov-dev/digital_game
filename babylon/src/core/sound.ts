// Мост между настройкой звука игрока и платформенным SDK.
//
// Пользовательская кнопка меняет локальное состояние и сообщает площадке
// (GamePush умеет mute/unmute). Площадка, наоборот, может запретить звук
// (CrazyGames muteAudio, YouTube isAudioEnabled) — это состояние важнее
// внутриигрового переключателя и учитывается аудиоменеджером.

import { platform } from '../platform';
import { setSdkAudioEnabled, setSoundEnabled, unlockAudio } from './audio';

export function applySoundPreference(enabled: boolean): void {
  setSoundEnabled(enabled);
  platform.setAudioEnabled(enabled);
}

/** Вызывается после initPlatform() и загрузки настроек. */
export function initSound(enabled: boolean): void {
  setSoundEnabled(enabled);
  setSdkAudioEnabled(platform.isAudioEnabled());
  platform.onAudioChange((value) => setSdkAudioEnabled(value));
  platform.setAudioEnabled(enabled);
}

/** Первый жест игрока разблокирует AudioContext в мобильных браузерах. */
export function unlockGameAudio(): void {
  unlockAudio();
}
