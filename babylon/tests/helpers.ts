import { tileById } from '../src/core/deck';
import { TileFace } from '../src/core/tile';

export function faces(ids: number[]): TileFace[] {
  return ids.map((id) => tileById(id));
}
