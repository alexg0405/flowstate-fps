import { describe, expect, it } from 'vitest';
import { hashSeed, SeededRandom } from '../src/simulation/random';

describe('seeded simulation randomness', () => {
  it('replays the same sequence for the same level seed', () => {
    const first = new SeededRandom(hashSeed('white-line:1'));
    const second = new SeededRandom(hashSeed('white-line:1'));
    expect(Array.from({ length: 12 }, () => first.next())).toEqual(Array.from({ length: 12 }, () => second.next()));
  });

  it('uses different sequences for different level IDs', () => {
    const first = new SeededRandom(hashSeed('white-line:1'));
    const second = new SeededRandom(hashSeed('another-level:1'));
    expect(first.next()).not.toBe(second.next());
  });
});
