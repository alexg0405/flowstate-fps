import { describe, expect, it } from 'vitest';
import { approach, consumeAirCharge, resetFromGround, resetFromWall } from '../src/simulation/movementRules';

describe('surface-reset movement tech', () => {
  it('does not allow the same wall to recharge repeatedly', () => {
    const first = resetFromWall({ airCharge: 0, lastRechargeSurface: 'ground' }, 'wall:left');
    expect(first).toEqual({ airCharge: 1, lastRechargeSurface: 'wall:left' });
    const consumed = consumeAirCharge(first);
    expect(resetFromWall(consumed, 'wall:left')).toEqual(consumed);
  });

  it('recharges on a new wall or stable ground', () => {
    const empty = { airCharge: 0, lastRechargeSurface: 'wall:left' };
    expect(resetFromWall(empty, 'wall:right').airCharge).toBe(1);
    expect(resetFromGround(empty)).toEqual({ airCharge: 1, lastRechargeSurface: 'ground' });
  });

  it('approaches without overshooting', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(9, 10, 3)).toBe(10);
    expect(approach(2, -4, 2)).toBe(0);
  });
});
