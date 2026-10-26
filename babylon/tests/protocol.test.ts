import { describe, expect, it } from 'vitest';
import { S2C, clean, parsePacket } from '../src/net/protocol';

describe('clean', () => {
  it('убирает null-поля', () => {
    const out = clean({ a: 1, b: null, c: { d: null, e: 2 }, f: [1, null, 3] }) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, c: { e: 2 }, f: [1, '', 3] });
  });
});

describe('parsePacket', () => {
  it('парсит hello', () => {
    const pkt = parsePacket(JSON.stringify({ t: S2C.HELLO, server: { id: 'srv-ru' }, graceMs: 1500 }));
    expect(pkt.t).toBe(S2C.HELLO);
    expect((pkt as { graceMs?: number }).graceMs).toBe(1500);
  });

  it('бросает на мусоре', () => {
    expect(() => parsePacket('not json')).toThrow();
  });
});

describe('константы протокола', () => {
  it('клиентские операции', () => {
    expect(S2C.GAME_STATE).toBe('game.state');
    expect(S2C.ROOM_STATE).toBe('room.state');
    expect(S2C.QUICK_STATE).toBe('quick.state');
  });
});
