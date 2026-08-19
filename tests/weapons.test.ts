import { describe, expect, it } from 'vitest';
import type { WeaponBuild } from '../src/contracts';
import {
  defaultArmory,
  defaultBuildFor,
  getWeaponChassis,
  partsForSlot,
  resolveWeaponStats,
  weaponChassis,
  weaponParts,
  weaponPartSlots,
} from '../src/content/weapons';

function build(overrides: Partial<WeaponBuild> = {}): WeaponBuild {
  return { ...defaultBuildFor('carbine', 'test', 'Test'), ...overrides };
}

describe('weapon stat resolution', () => {
  it('returns the chassis base when only neutral parts are fitted', () => {
    const base = getWeaponChassis('carbine')!.base;
    expect(resolveWeaponStats(build())).toEqual(base);
  });

  it('applies part modifiers multiplicatively against the base', () => {
    const base = getWeaponChassis('carbine')!.base;
    const stats = resolveWeaponStats(build({ parts: { ...build().parts, magazine: 'magazine.extended' } }));
    expect(stats.magazineSize).toBe(Math.round(base.magazineSize * 1.5));
    expect(stats.reloadSeconds).toBeCloseTo(base.reloadSeconds * 1.22, 6);
    expect(stats.damage).toBe(base.damage);
  });

  it('stacks modifiers across slots', () => {
    const base = getWeaponChassis('carbine')!.base;
    const stats = resolveWeaponStats(build({
      parts: { optic: 'optic.reflex', barrel: 'barrel.long', magazine: 'magazine.standard', grip: 'grip.angled', stock: 'stock.heavy' },
    }));
    expect(stats.adsSpread).toBeCloseTo(base.adsSpread * 0.72 * 0.86 * 0.66, 8);
    expect(stats.range).toBeCloseTo(base.range * 1.4, 6);
    expect(stats.roundsPerMinute).toBe(Math.round(base.roundsPerMinute * 0.94 * 1.03 * 0.92));
  });

  it('rounds the stats that must stay whole numbers', () => {
    const stats = resolveWeaponStats(build({ chassisId: 'dmr', parts: { magazine: 'magazine.quickfeed' } }));
    expect(Number.isInteger(stats.magazineSize)).toBe(true);
    expect(Number.isInteger(stats.reserveAmmo)).toBe(true);
    expect(Number.isInteger(stats.roundsPerMinute)).toBe(true);
  });

  it('ignores unknown parts, wrong-slot parts, and parts the chassis cannot take', () => {
    const base = getWeaponChassis('carbine')!.base;
    const stats = resolveWeaponStats(build({
      parts: {
        optic: 'optic.nonexistent',
        // A barrel id parked in the magazine slot must not apply.
        magazine: 'barrel.long',
        // The choke is shotgun-only.
        barrel: 'barrel.choke',
      },
    }));
    expect(stats).toEqual(base);
  });

  it('accepts the choke on a shotgun', () => {
    const base = getWeaponChassis('shotgun')!.base;
    const stats = resolveWeaponStats(build({ chassisId: 'shotgun', parts: { barrel: 'barrel.choke' } }));
    expect(stats.hipSpread).toBeCloseTo(base.hipSpread * 0.55, 8);
    expect(stats.pellets).toBe(base.pellets);
  });

  it('falls back to the first chassis when the id is unknown', () => {
    const stats = resolveWeaponStats({ id: 'x', name: 'x', chassisId: 'blaster' as never, parts: {} });
    expect(stats).toEqual(weaponChassis[0].base);
  });

  it('keeps every stat inside its playable envelope no matter how parts stack', () => {
    // Deliberately pile on every accuracy-degrading and capacity-inflating part.
    const worst = resolveWeaponStats(build({ parts: { barrel: 'barrel.long', magazine: 'magazine.drum', stock: 'stock.light' } }));
    expect(worst.hipSpread).toBeLessThanOrEqual(0.16);
    expect(worst.magazineSize).toBeLessThanOrEqual(120);
    expect(worst.roundsPerMinute).toBeLessThanOrEqual(1400);

    for (const chassis of weaponChassis) {
      for (const part of weaponParts) {
        const stats = resolveWeaponStats(build({ chassisId: chassis.id, parts: { [part.slot]: part.id } }));
        expect(stats.damage).toBeGreaterThan(0);
        expect(stats.adsSpread).toBeGreaterThan(0);
        expect(stats.magazineSize).toBeGreaterThanOrEqual(2);
        expect(stats.roundsPerMinute).toBeGreaterThanOrEqual(60);
      }
    }
  });
});

describe('weapon catalog', () => {
  it('offers at least one part per slot for every chassis', () => {
    for (const chassis of weaponChassis) {
      for (const slot of weaponPartSlots) {
        expect(partsForSlot(chassis.id, slot).length).toBeGreaterThan(0);
      }
    }
  });

  it('only offers chassis-restricted parts to their chassis', () => {
    expect(partsForSlot('carbine', 'barrel').map((part) => part.id)).not.toContain('barrel.choke');
    expect(partsForSlot('shotgun', 'barrel').map((part) => part.id)).toContain('barrel.choke');
  });

  it('seeds a two-build armory with distinct ids and resolvable stats', () => {
    const armory = defaultArmory();
    expect(armory).toHaveLength(2);
    expect(new Set(armory.map((entry) => entry.id)).size).toBe(2);
    for (const entry of armory) expect(resolveWeaponStats(entry).damage).toBeGreaterThan(0);
  });
});
